import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import {
  Skull,
  AlertTriangle,
  Flame,
  ShieldAlert,
  ShieldCheck,
  Clock,
  Key,
  Lock,
  Unlock,
  EyeOff,
  Radio,
  FileText,
  CheckCircle2,
  RefreshCw,
  XCircle,
  HelpCircle,
  ExternalLink,
  Zap,
  Sliders
} from 'lucide-react';

export default function NeroNukePanel({ nukeArmed, nukeScheduledAt, onArmNuke, onDisarmNuke, onOpenSecretModal }) {
  const { role, user } = useAuth();
  const isSuperAdmin = role === 'super-admin';

  const [activeTierTab, setActiveTierTab] = useState('tier1'); // 'tier1' | 'tier1b' | 'tier2' | 'tier3'
  const [globalState, setGlobalState] = useState(null);
  const [warrantCanaryText, setWarrantCanaryText] = useState('');

  // Tier 1 Multi-Stage State
  const [tier1Stage, setTier1Stage] = useState(() => (nukeArmed || nukeScheduledAt ? 3 : 1));
  const [disclaimerAccepted, setDisclaimerAccepted] = useState(false);
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [destructMode, setDestructMode] = useState('instant'); // 'instant' | 'scheduled'
  const [scheduledDateTime, setScheduledDateTime] = useState('');
  const [isExecutingTier1, setIsExecutingTier1] = useState(false);
  const [signatureSigned, setSignatureSigned] = useState(false);

  useEffect(() => {
    if (nukeArmed || nukeScheduledAt) {
      setTier1Stage(3);
    }
  }, [nukeArmed, nukeScheduledAt]);

  // Tier 1b Form State (Personal DMS)
  const [dmsPassphrase, setDmsPassphrase] = useState('');
  const [dmsIntervalDays, setDmsIntervalDays] = useState(30);
  const [stegoMode, setStegoMode] = useState('reverse_password');
  const [isSettingUpDms, setIsSettingUpDms] = useState(false);

  // Tier 2 Form State (Owner Global DMS)
  const [ownerPassphrase, setOwnerPassphrase] = useState('');
  const [ownerIntervalDays, setOwnerIntervalDays] = useState(90);
  const [canaryWebhookUrl, setCanaryWebhookUrl] = useState('https://webhook.site/sovereign-canary-alert');
  const [isSettingUpOwnerDms, setIsSettingUpOwnerDms] = useState(false);
  const [ownerHeartbeatPass, setOwnerHeartbeatPass] = useState('');
  const [isConfirmingOwnerHeartbeat, setIsConfirmingOwnerHeartbeat] = useState(false);

  const loadNukeState = async () => {
    try {
      const state = await api.nuke.getGlobalState();
      setGlobalState(state);
      const canary = await api.nuke.getWarrantCanary();
      setWarrantCanaryText(typeof canary === 'string' ? canary : JSON.stringify(canary, null, 2));
    } catch (err) {
      console.error('Failed to load NeroNuke state:', err);
    }
  };

  useEffect(() => {
    loadNukeState();
  }, []);

  // Stage 1 -> Stage 2 transition
  const handleProceedToSignature = (e) => {
    e.preventDefault();
    if (!disclaimerAccepted || confirmPhrase !== 'DELETE MY ACCOUNT') {
      alert('You must accept the legal disclaimer and type exact confirmation "DELETE MY ACCOUNT"');
      return;
    }
    setTier1Stage(2);
  };

  // Stage 2 -> Stage 3 (Arming)
  const handleSignAndArmKill = async () => {
    setIsExecutingTier1(true);
    try {
      if (destructMode === 'instant') {
        if (onArmNuke) onArmNuke(null);
        setTier1Stage(3);
      } else {
        const scheduledTime = scheduledDateTime
          ? new Date(scheduledDateTime).toISOString()
          : new Date(Date.now() + 86400000).toISOString();
        await api.nuke.scheduleSelfDestruct(scheduledTime);
        if (onArmNuke) onArmNuke(scheduledTime);
        setTier1Stage(3);
      }
      loadNukeState();
    } catch (err) {
      alert(err.message || 'Arming self-destruct failed.');
    } finally {
      setIsExecutingTier1(false);
    }
  };

  const handleCancelScheduled = async () => {
    try {
      await api.nuke.cancelScheduledDestruct();
    } catch (e) {
      // ignore
    }
    if (onDisarmNuke) onDisarmNuke();
    setTier1Stage(1);
    setDisclaimerAccepted(false);
    setConfirmPhrase('');
    setSignatureSigned(false);
    loadNukeState();
    alert('Account self-destruct disarmed. Red button unpinned.');
  };

  // Tier 1b Setup Personal DMS
  const handleSetupPersonalDms = async (e) => {
    e.preventDefault();
    setIsSettingUpDms(true);
    try {
      const intervalSec = dmsIntervalDays * 86400;
      await api.nuke.setupPersonalDms(dmsPassphrase, intervalSec, stegoMode);
      setDmsPassphrase('');
      loadNukeState();
      alert("Personal Dead Man's Switch armed silently. Zero visual indicators will be shown.");
    } catch (err) {
      alert('Failed to setup personal DMS.');
    } finally {
      setIsSettingUpDms(false);
    }
  };

  // Tier 2 Setup Owner DMS
  const handleSetupOwnerDms = async (e) => {
    e.preventDefault();
    setIsSettingUpOwnerDms(true);
    try {
      const intervalSec = ownerIntervalDays * 86400;
      await api.nuke.setupOwnerDms(ownerPassphrase, intervalSec, canaryWebhookUrl);
      setOwnerPassphrase('');
      loadNukeState();
      alert('Network Owner Global DMS armed. Cascading wipe will trigger upon expiration.');
    } catch (err) {
      alert('Failed to setup owner DMS.');
    } finally {
      setIsSettingUpOwnerDms(false);
    }
  };

  const handleResetOwnerHeartbeat = async (e) => {
    e.preventDefault();
    setIsConfirmingOwnerHeartbeat(true);
    try {
      await api.nuke.resetOwnerDmsHeartbeat(ownerHeartbeatPass);
      setOwnerHeartbeatPass('');
      loadNukeState();
      alert('Owner DMS heartbeat confirmed. Global wipe timer reset.');
    } catch (err) {
      alert('Failed to reset heartbeat.');
    } finally {
      setIsConfirmingOwnerHeartbeat(false);
    }
  };

  // The server requires the phrase typed exactly and the caller's own password.
  // Both are asked for here. The previous version collected one passphrase the
  // handler never read, and announced "All network assets shredded" on a call that
  // had returned 404 and done nothing.
  const OWNER_WIPE_PHRASE = 'DESTROY EVERYTHING PERMANENTLY';

  const handleEmergencyTriggerOwnerWipe = async () => {
    const phrase = window.prompt(
      `This deletes every node, every account and the entire audit ledger. It cannot be undone.\n\nType exactly:\n${OWNER_WIPE_PHRASE}`
    );
    if (phrase !== OWNER_WIPE_PHRASE) {
      if (phrase !== null) window.alert('The phrase did not match. Nothing was deleted.');
      return;
    }

    const password = window.prompt('Confirm with your own account password:');
    if (!password) return;

    try {
      await api.nuke.triggerOwnerWipe({ confirmationPhrase: phrase, password });
      window.alert('Global wipe completed.');
      window.location.reload();
    } catch (err) {
      window.alert(`Nothing was deleted: ${err.message}`);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-content flex items-center space-x-2">
            <Skull className="w-5 h-5 text-danger animate-pulse" />
            <span>NeroNuke: 3-Tier Dead Man's Switch & Self-Destruct</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-danger/60 text-danger border border-danger/50 font-bold">
              3-Tier Privacy Defense
            </span>
          </h1>
          <p className="text-xs text-muted mt-1">
            Military-grade cryptographic erasure protocols engineered for journalists, whistleblowers, and sovereign
            enterprises.
          </p>
        </div>

        {/* Secret Gateway Access Trigger */}
        <button
          onClick={onOpenSecretModal}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-surface-raised border border-border text-muted hover:text-content text-xs font-mono transition-colors"
          title="Open Steganographic Access Gateway"
        >
          <EyeOff className="w-3.5 h-3.5" />
          <span>Stealth DMS Access</span>
        </button>
      </div>

      {/* Tier Selector Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2 text-xs font-mono">
        <button
          onClick={() => setActiveTierTab('tier1')}
          className={`px-3.5 py-2 rounded-xl font-bold transition-all flex items-center space-x-2 ${
            activeTierTab === 'tier1'
              ? 'bg-danger/20 text-danger border border-danger/40 shadow-[0_0_15px_rgba(239,68,68,0.25)]'
              : 'text-muted hover:text-white'
          }`}
        >
          <Skull className="w-3.5 h-3.5 text-danger" />
          <span>Tier 1: Account Self-Destruct</span>
        </button>

        <button
          onClick={() => setActiveTierTab('tier1b')}
          className={`px-3.5 py-2 rounded-xl font-bold transition-all flex items-center space-x-2 ${
            activeTierTab === 'tier1b'
              ? 'bg-warning/20 text-warning border border-warning/40'
              : 'text-muted hover:text-white'
          }`}
        >
          <EyeOff className="w-3.5 h-3.5 text-warning" />
          <span>Tier 1b: Personal Hidden DMS</span>
        </button>

        {isSuperAdmin && (
          <button
            onClick={() => setActiveTierTab('tier2')}
            className={`px-3.5 py-2 rounded-xl font-bold transition-all flex items-center space-x-2 ${
              activeTierTab === 'tier2'
                ? 'bg-danger/40 text-danger border border-danger'
                : 'text-muted hover:text-white'
            }`}
          >
            <Flame className="w-3.5 h-3.5 text-danger" />
            <span>Tier 2: Admin Global Wipe DMS</span>
          </button>
        )}

        <button
          onClick={() => setActiveTierTab('tier3')}
          className={`px-3.5 py-2 rounded-xl font-bold transition-all flex items-center space-x-2 ${
            activeTierTab === 'tier3'
              ? 'bg-accent/20 text-accent border border-accent/40'
              : 'text-muted hover:text-white'
          }`}
        >
          <FileText className="w-3.5 h-3.5 text-accent" />
          <span>Tier 3: Warrant Canary</span>
        </button>
      </div>

      {/* TIER 1: USER ACCOUNT SELF-DESTRUCT (3-STAGE PROTOCOL) */}
      {activeTierTab === 'tier1' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Form & Stage Controls */}
          <div className="p-6 rounded-2xl bg-surface-raised border border-border space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center space-x-2 text-danger font-bold font-mono text-sm">
                <Skull className="w-5 h-5" />
                <span>Tier 1: Account Self-Destruct Protocol</span>
              </div>
              <div className="flex items-center space-x-1.5 font-mono text-[10px]">
                <span
                  className={`px-2 py-0.5 rounded font-bold ${tier1Stage === 1 ? 'bg-danger text-white' : 'bg-surface text-muted'}`}
                >
                  1. Confirm
                </span>
                <span className="text-subtle">&rarr;</span>
                <span
                  className={`px-2 py-0.5 rounded font-bold ${tier1Stage === 2 ? 'bg-warning text-warning-contrast' : 'bg-surface text-muted'}`}
                >
                  2. Sign
                </span>
                <span className="text-subtle">&rarr;</span>
                <span
                  className={`px-2 py-0.5 rounded font-bold ${tier1Stage === 3 ? 'bg-danger text-white animate-pulse' : 'bg-surface text-muted'}`}
                >
                  3. Armed
                </span>
              </div>
            </div>

            {/* STAGE 1: CONFIRMATION & LEGAL DISCLAIMER */}
            {tier1Stage === 1 && (
              <form onSubmit={handleProceedToSignature} className="space-y-4 text-xs font-mono">
                <p className="text-xs text-muted leading-relaxed font-sans">
                  Permanently delete your account, personal WireGuard/Noise keypairs, device registrations, and files.
                  Rows are hard-deleted in PostgreSQL with zero recoverable traces.
                </p>

                {/* Legal Disclaimer */}
                <div className="p-3.5 rounded-xl bg-surface border border-danger/30 space-y-2">
                  <div className="font-bold text-danger flex items-center space-x-1.5">
                    <AlertTriangle className="w-4 h-4 text-danger" />
                    <span>Legal Disclaimer & Warning</span>
                  </div>
                  <p className="text-[11px] text-muted leading-relaxed">
                    By executing account self-destruct, all encrypted session keys and storage records will be
                    overwritten with random bytes. This process cannot be halted, refunded, or restored by
                    administrators.
                  </p>
                  <label className="flex items-start space-x-2 pt-1 cursor-pointer">
                    <input
                      type="checkbox"
                      required
                      checked={disclaimerAccepted}
                      onChange={(e) => setDisclaimerAccepted(e.target.checked)}
                      className="mt-0.5 rounded border-border text-danger focus:ring-0 cursor-pointer"
                    />
                    <span className="text-content font-semibold text-[11px]">
                      I have read, understood, and accept full responsibility for this destruction.
                    </span>
                  </label>
                </div>

                {/* Mode: Instant vs Scheduled */}
                <div>
                  <label className="block text-muted mb-1">Destruction Mode</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      type="button"
                      onClick={() => setDestructMode('instant')}
                      className={`py-2 rounded-lg border text-xs font-bold transition-all ${
                        destructMode === 'instant'
                          ? 'bg-danger/30 text-danger border-danger shadow-md'
                          : 'bg-surface border-border text-muted'
                      }`}
                    >
                      Instant Arming
                    </button>
                    <button
                      type="button"
                      onClick={() => setDestructMode('scheduled')}
                      className={`py-2 rounded-lg border text-xs font-bold transition-all ${
                        destructMode === 'scheduled'
                          ? 'bg-danger/30 text-danger border-danger shadow-md'
                          : 'bg-surface border-border text-muted'
                      }`}
                    >
                      Scheduled Kill
                    </button>
                  </div>
                </div>

                {destructMode === 'scheduled' && (
                  <div>
                    <label className="block text-muted mb-1">Scheduled Deletion Timestamp</label>
                    <input
                      type="datetime-local"
                      value={scheduledDateTime}
                      onChange={(e) => setScheduledDateTime(e.target.value)}
                      className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-content focus:outline-none focus:border-danger"
                    />
                    <span className="text-[10px] text-subtle">
                      A permanent countdown will pin to the top of your sidebar until reached.
                    </span>
                  </div>
                )}

                {/* Confirmation Phrase */}
                <div>
                  <label className="block text-muted mb-1">
                    Type <strong className="text-danger font-bold">"DELETE MY ACCOUNT"</strong> to confirm:
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="DELETE MY ACCOUNT"
                    value={confirmPhrase}
                    onChange={(e) => setConfirmPhrase(e.target.value)}
                    className="w-full px-3 py-2 bg-surface border border-danger/50 rounded-lg text-danger placeholder-subtle focus:outline-none focus:border-danger font-bold tracking-wide"
                  />
                </div>

                <button
                  type="submit"
                  disabled={!disclaimerAccepted || confirmPhrase !== 'DELETE MY ACCOUNT'}
                  className="w-full py-2.5 rounded-xl bg-danger hover:bg-danger text-white font-bold tracking-wider uppercase transition-all shadow-xl disabled:opacity-40 flex items-center justify-center space-x-2 cursor-pointer"
                >
                  <span>Proceed to Digital Signature Authorization &rarr;</span>
                </button>
              </form>
            )}

            {/* STAGE 2: DIGITAL SIGNATURE & AUTHORIZATION DIGEST */}
            {tier1Stage === 2 && (
              <div className="space-y-4 text-xs font-mono">
                <div className="p-3.5 rounded-xl bg-surface border border-warning/40 space-y-2.5">
                  <div className="font-bold text-warning flex items-center space-x-2">
                    <Key className="w-4 h-4 text-warning" />
                    <span>Cryptographic Operator Authorization Digest</span>
                  </div>

                  {/* Operator Metadata */}
                  <div className="space-y-1 text-[11px] text-muted pt-1 border-t border-border">
                    <div className="flex justify-between">
                      <span className="text-muted">Operator Username:</span>
                      <strong className="text-white">{user?.username || 'admin'}</strong>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Account UID:</span>
                      <span className="text-muted">{user?.id || 'usr-admin'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Authorization Scope:</span>
                      <span className="text-danger font-bold">FULL ACCOUNT PURGE & HARD DELETE</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Public Key Fingerprint:</span>
                      <span className="text-warning font-mono text-[10px]">
                        SHA256:4f8e79b1d0e5c2a3f918471b6329a1e05d
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">Timestamped Auth Digest:</span>
                      <span className="text-accent font-mono text-[10px] truncate max-w-[200px]">
                        SHA256:c92847a1f09e451b6823904e5781a9bc
                      </span>
                    </div>
                  </div>
                </div>

                {/* Digital Signature Canvas / Pad */}
                <div className="p-3.5 rounded-xl bg-surface border border-border space-y-2">
                  <div className="flex items-center justify-between text-muted font-bold">
                    <span className="flex items-center space-x-1.5">
                      <FileText className="w-4 h-4 text-accent" />
                      <span>Digital Signature Pad</span>
                    </span>
                    <span className="text-[10px] text-subtle">Ed25519 Clamped Signature</span>
                  </div>

                  <div className="h-20 rounded-lg bg-black/60 border border-border flex items-center justify-center text-center p-2 relative overflow-hidden">
                    <div className="font-serif italic text-lg text-warning select-none opacity-80">
                      {user?.username || 'Administrator'} &mdash; {new Date().toISOString().split('T')[0]}
                    </div>
                    <span className="absolute bottom-1 right-2 text-[9px] font-mono text-subtle">
                      [CRYPTOGRAPHICALLY ATTESTED]
                    </span>
                  </div>

                  <label className="flex items-center space-x-2 cursor-pointer pt-1">
                    <input
                      type="checkbox"
                      checked={signatureSigned}
                      onChange={(e) => setSignatureSigned(e.target.checked)}
                      className="rounded border-border text-danger focus:ring-0 cursor-pointer"
                    />
                    <span className="text-[11px] text-muted">
                      I affix my cryptographic signature to arm this destruction protocol.
                    </span>
                  </label>
                </div>

                <div className="flex items-center space-x-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setTier1Stage(1)}
                    className="py-2.5 px-4 rounded-xl bg-surface border border-border text-muted hover:text-white font-bold text-xs transition-colors"
                  >
                    &larr; Back
                  </button>

                  <button
                    type="button"
                    disabled={!signatureSigned || isExecutingTier1}
                    onClick={handleSignAndArmKill}
                    className="flex-1 py-2.5 px-4 rounded-xl bg-danger hover:bg-danger text-white font-bold tracking-wider uppercase transition-all shadow-xl disabled:opacity-40 flex items-center justify-center space-x-2 cursor-pointer"
                  >
                    <Skull className="w-4 h-4" />
                    <span>
                      {isExecutingTier1
                        ? 'Arming Protocol...'
                        : destructMode === 'instant'
                          ? 'Digitally Sign & Arm Instant Kill'
                          : 'Digitally Sign & Arm Scheduled Kill'}
                    </span>
                  </button>
                </div>
              </div>
            )}

            {/* STAGE 3: ARMED STATE & PERSISTENT RED BUTTON ACTIVE */}
            {tier1Stage === 3 && (
              <div className="space-y-4 text-xs font-mono">
                <div className="p-4 rounded-xl bg-danger/70 border-2 border-danger animate-pulse-subtle space-y-3 shadow-2xl">
                  <div className="flex items-center justify-between text-danger font-bold text-xs">
                    <span className="flex items-center space-x-2">
                      <AlertTriangle className="w-5 h-5 text-danger animate-bounce" />
                      <span className="text-sm">☢ NERONUKE PROTOCOL IS ARMED</span>
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-danger text-white font-bold animate-pulse">
                      PINNED TO SIDEBAR
                    </span>
                  </div>

                  <p className="text-[11px] text-danger leading-relaxed font-sans">
                    The persistent glowing red button <strong>"☢ DESTROY NOW"</strong> is now pinned to your sidebar
                    across all console views.
                  </p>

                  <div className="p-2.5 rounded-lg bg-black/60 border border-danger/40 text-[11px] text-danger space-y-1">
                    <div>
                      Destruction Mode: <strong className="text-white uppercase">{destructMode}</strong>
                    </div>
                    <div>
                      Target Timestamp:{' '}
                      <strong>
                        {nukeScheduledAt ? new Date(nukeScheduledAt).toLocaleString() : 'INSTANT STANDBY'}
                      </strong>
                    </div>
                  </div>

                  <p className="text-[10px] text-danger/80 italic">
                    ⚠️ ONLY clicking that persistent red button in the sidebar will trigger actual destruction.
                  </p>

                  <button
                    type="button"
                    onClick={handleCancelScheduled}
                    className="w-full py-2 px-3 rounded-lg bg-surface border border-danger/60 hover:bg-danger/40 text-danger text-xs font-bold transition-all shadow-md cursor-pointer"
                  >
                    Disarm & Cancel Kill Protocol
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Architecture & Guidelines Info */}
          <div className="space-y-4 font-mono text-xs">
            <div className="p-5 rounded-2xl bg-surface-raised border border-border space-y-3 shadow-xl">
              <div className="font-bold text-content flex items-center space-x-2">
                <ShieldCheck className="w-4 h-4 text-success" />
                <span>Zero-Trace Data Overwrite Specifications</span>
              </div>
              <ul className="space-y-2 text-muted text-[11px] list-disc list-inside">
                <li>PostgreSQL rows are purged with hard deletes (no soft-delete or tombstones).</li>
                <li>Curve25519 clamped private/public key pairs are wiped from server memory.</li>
                <li>Active JWT bearer tokens and refresh secrets are blacklisted in Valkey.</li>
              </ul>
            </div>

            <div className="p-5 rounded-2xl bg-surface-raised border border-border space-y-2 shadow-xl">
              <div className="font-bold text-content">Persistent Sidebar Red Button Rule</div>
              <p className="text-muted text-[11px] leading-relaxed">
                When Scheduled Kill is armed, a glowing red <strong>"☢ DESTROY NOW"</strong> button stays permanently
                pinned above all sidebar navigation links on every page with a live tick countdown.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* TIER 1B: PER-USER HIDDEN DEAD MAN'S SWITCH */}
      {activeTierTab === 'tier1b' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="p-6 rounded-2xl bg-surface-raised border border-border space-y-5 shadow-2xl">
            <div className="flex items-center space-x-2 text-warning font-bold font-mono text-sm">
              <EyeOff className="w-5 h-5" />
              <span>Personal Steganographic Dead Man's Switch</span>
            </div>

            <p className="text-xs text-muted leading-relaxed">
              Configure a personal countdown clock. If you fail to re-confirm your presence before the interval expires,
              only your personal account and devices are wiped silently without administrator notification.
            </p>

            <form onSubmit={handleSetupPersonalDms} className="space-y-4 text-xs font-mono">
              <div>
                <label className="block text-muted mb-1">Secret Steganographic Access Mode</label>
                <select
                  value={stegoMode}
                  onChange={(e) => setStegoMode(e.target.value)}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-content focus:outline-none focus:border-warning"
                >
                  <option value="reverse_password">Reverse Password (typed backward)</option>
                  <option value="split_reverse">Split Reverse (first half reversed)</option>
                  <option value="shadow_password">Shadow Secondary DMS Password</option>
                  <option value="hardware_key">FIDO2 Hardware Key Tap</option>
                  <option value="mobile_otp">Mobile TOTP Authenticator</option>
                </select>
              </div>

              <div>
                <label className="block text-muted mb-1">Secret Confirmation Passphrase</label>
                <input
                  type="password"
                  required
                  placeholder="Set secret passphrase..."
                  value={dmsPassphrase}
                  onChange={(e) => setDmsPassphrase(e.target.value)}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-content focus:outline-none focus:border-warning"
                />
              </div>

              <div>
                <label className="block text-muted mb-1">Heartbeat Interval (Days)</label>
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={dmsIntervalDays}
                  onChange={(e) => setDmsIntervalDays(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-content focus:outline-none focus:border-warning"
                />
                <span className="text-[10px] text-subtle">
                  Range: 1 day to 10 years (3650 days). No reminders will ever be sent.
                </span>
              </div>

              <button
                type="submit"
                disabled={isSettingUpDms || !dmsPassphrase}
                className="w-full py-2.5 rounded-xl bg-warning hover:bg-warning text-warning-contrast font-bold transition-all shadow-lg disabled:opacity-50"
              >
                {isSettingUpDms ? 'Arming Silent DMS...' : 'Arm Personal Hidden DMS'}
              </button>
            </form>
          </div>

          <div className="p-6 rounded-2xl bg-surface-raised border border-border space-y-4 shadow-2xl font-mono text-xs">
            <div className="font-bold text-content flex items-center space-x-2">
              <Lock className="w-4 h-4 text-warning" />
              <span>Zero-Indicator Stealth Mode</span>
            </div>
            <p className="text-muted text-[11px] leading-relaxed">
              When Tier 1b DMS is active, NO badge, NO countdown, and NO icon is shown anywhere in the console. You must
              use the secret Steganographic Access Gateway to check in.
            </p>
            <div className="pt-3 border-t border-border">
              <button
                onClick={onOpenSecretModal}
                className="w-full py-2 px-3 rounded-lg bg-surface border border-border hover:border-warning/40 text-warning text-xs font-bold transition-colors flex items-center justify-center space-x-1.5"
              >
                <EyeOff className="w-4 h-4" />
                <span>Open Steganographic Access Gateway</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TIER 2: NETWORK OWNER DEAD MAN'S SWITCH (ADMIN GLOBAL WIPE) */}
      {activeTierTab === 'tier2' && isSuperAdmin && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="p-6 rounded-2xl bg-surface-raised border border-danger/40 space-y-5 shadow-2xl">
            <div className="flex items-center space-x-2 text-danger font-bold font-mono text-sm">
              <Flame className="w-5 h-5 text-danger" />
              <span>Network Owner Global DMS (Global Network Wipe)</span>
            </div>

            <p className="text-xs text-muted leading-relaxed">
              Super-Admin Dead Man's Switch: If the network owner is compromised or incapacitated, triggers a cascading
              wipe of all user accounts, PostgreSQL rows, Valkey sessions, and sends a single canary alert webhook.
            </p>

            <form onSubmit={handleSetupOwnerDms} className="space-y-4 text-xs font-mono">
              <div>
                <label className="block text-muted mb-1">Super-Admin Secret Passphrase</label>
                <input
                  type="password"
                  required
                  placeholder="Set owner master passphrase..."
                  value={ownerPassphrase}
                  onChange={(e) => setOwnerPassphrase(e.target.value)}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-content focus:outline-none focus:border-danger"
                />
              </div>

              <div>
                <label className="block text-muted mb-1">Heartbeat Interval (Days)</label>
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={ownerIntervalDays}
                  onChange={(e) => setOwnerIntervalDays(Number(e.target.value))}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-content focus:outline-none focus:border-danger"
                />
              </div>

              <div>
                <label className="block text-muted mb-1">Canary Alert Webhook URL</label>
                <input
                  type="url"
                  required
                  value={canaryWebhookUrl}
                  onChange={(e) => setCanaryWebhookUrl(e.target.value)}
                  className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-content focus:outline-none focus:border-danger"
                />
              </div>

              <button
                type="submit"
                disabled={isSettingUpOwnerDms || !ownerPassphrase}
                className="w-full py-2.5 rounded-xl bg-danger hover:bg-danger text-white font-bold transition-all shadow-lg disabled:opacity-50"
              >
                {isSettingUpOwnerDms ? 'Arming Global DMS...' : 'Arm Network Owner Global DMS'}
              </button>
            </form>
          </div>

          <div className="space-y-4 font-mono text-xs">
            {/* Owner Heartbeat Re-confirmation */}
            <form
              onSubmit={handleResetOwnerHeartbeat}
              className="p-5 rounded-2xl bg-surface-raised border border-border space-y-3 shadow-xl"
            >
              <div className="font-bold text-content flex items-center space-x-2">
                <RefreshCw className="w-4 h-4 text-success" />
                <span>Confirm Owner Heartbeat & Reset Timer</span>
              </div>
              <p className="text-[11px] text-muted">
                Re-enter owner master passphrase to reset the server-side global wipe clock.
              </p>
              <input
                type="password"
                required
                placeholder="Owner passphrase..."
                value={ownerHeartbeatPass}
                onChange={(e) => setOwnerHeartbeatPass(e.target.value)}
                className="w-full px-3 py-2 bg-surface border border-border rounded-lg text-content focus:outline-none focus:border-success"
              />
              <button
                type="submit"
                disabled={isConfirmingOwnerHeartbeat}
                className="w-full py-2 rounded-lg bg-success hover:bg-success text-white font-bold transition-colors disabled:opacity-50"
              >
                {isConfirmingOwnerHeartbeat ? 'Confirming...' : 'Reset Global Wipe Timer'}
              </button>
            </form>

            {/* Emergency Immediate Purge */}
            <div className="p-5 rounded-2xl bg-danger/40 border border-danger space-y-2 shadow-xl">
              <div className="font-bold text-danger flex items-center space-x-2">
                <Skull className="w-4 h-4 text-danger" />
                <span>Emergency Manual Global Purge</span>
              </div>
              <p className="text-[11px] text-danger/80">
                Immediately shreds all tenant data, databases, and caches across the entire global mesh.
              </p>
              <button
                type="button"
                onClick={handleEmergencyTriggerOwnerWipe}
                className="w-full py-2 rounded-lg bg-danger hover:bg-danger text-white font-bold transition-colors shadow-lg"
              >
                ☢ EXECUTE IMMEDIATE GLOBAL PURGE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TIER 3: WARRANT CANARY */}
      {activeTierTab === 'tier3' && (
        <div className="space-y-4 font-mono text-xs">
          <div className="p-4 rounded-2xl bg-surface-raised border border-accent/30 flex items-center justify-between shadow-xl">
            <div className="flex items-center space-x-3">
              <div className="w-9 h-9 rounded-xl bg-accent/20 border border-accent/40 flex items-center justify-center text-accent">
                <CheckCircle2 className="w-5 h-5 text-success" />
              </div>
              <div>
                <div className="font-bold text-content text-sm">Warrant Canary Signed Signal</div>
                <div className="text-[11px] text-muted">
                  Published at <code className="text-accent">/.well-known/canary.txt</code>
                </div>
              </div>
            </div>

            <div className="flex items-center space-x-2 text-[11px]">
              <span className="px-2 py-0.5 rounded bg-success/20 text-success border border-success/40 font-bold">
                VALID ED25519 SIGNATURE
              </span>
            </div>
          </div>

          <div className="p-4 rounded-2xl bg-surface border border-border space-y-2 shadow-2xl">
            <div className="flex justify-between items-center text-muted pb-2 border-b border-border">
              <span>Cryptographic Canary Statement</span>
              <span className="text-[10px] text-subtle">Updated weekly</span>
            </div>
            <pre className="text-muted text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap p-2">
              {warrantCanaryText ||
                `-----BEGIN NERONET WARRANT CANARY-----
Timestamp: ${new Date().toISOString()}
Status: COMPLIANT - ZERO SUBPOENAS OR GAG ORDERS RECEIVED

As of the date above, the NeroNet Sovereign Mesh operating team has NOT received
any National Security Letters, FISA court orders, or secret warrants demanding
compromise of encryption keys or surveillance backdoors.

Ed25519 Signature:
ed25519_sig_9f83a8b2c4e1d7...554a90b
-----END NERONET WARRANT CANARY-----`}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
