import React, { useState } from 'react';
import { api } from './services/api';
import { AuthProvider, useAuth } from './context/AuthContext';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import Overview from './components/Overview';
import Topology3D from './components/Topology3D';
import NodeMatrix from './components/NodeMatrix';
import NodeActions from './components/NodeActions';
import UserManagement from './components/UserManagement';
import AppBundles from './components/AppBundles';
import PeeringManagement from './components/PeeringManagement';
import BehavioralRiskDashboard from './components/BehavioralRiskDashboard';
import GeoFencingMap from './components/GeoFencingMap';
import NeroNukePanel from './components/NeroNukePanel';
import NeroNukeSecretAccessModal from './components/NeroNukeSecretAccessModal';
import CryptoConfigModal from './components/CryptoConfigModal';
import SettingsACL from './components/SettingsACL';
import AuditLogs from './components/AuditLogs';
import OnionObfuscationPanel from './components/OnionObfuscationPanel';
import DataSourceBanner from './components/DataSourceBanner';
import { Settings, Shield, Terminal, Cpu, CheckCircle2, AlertTriangle } from 'lucide-react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-dark-canvas text-slate-100 font-mono p-6">
          <div className="max-w-xl w-full p-6 rounded-2xl bg-dark-card border border-red-500/50 shadow-2xl space-y-4">
            <div className="flex items-center space-x-3 text-red-400">
              <AlertTriangle className="w-6 h-6" />
              <h2 className="text-lg font-bold">Console Render Error</h2>
            </div>
            <p className="text-xs text-slate-300">
              An unexpected error occurred while rendering the management console:
            </p>
            <pre className="p-3 bg-dark-canvas border border-dark-border rounded-lg text-red-300 text-xs overflow-x-auto whitespace-pre-wrap">
              {this.state.error?.toString()}
            </pre>
            <div className="flex space-x-3 pt-2">
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-accent-primary text-slate-950 font-bold rounded-lg text-xs hover:brightness-110 cursor-pointer"
              >
                Reload Page
              </button>
              <button
                onClick={() => {
                  localStorage.clear();
                  window.location.reload();
                }}
                className="px-4 py-2 bg-dark-border text-slate-300 hover:text-white font-bold rounded-lg text-xs cursor-pointer"
              >
                Reset Session & Cache
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function MeshSettingsView() {
  const [pwdStandard, setPwdStandard] = React.useState('');
  const [pwdRoot, setPwdRoot] = React.useState('');
  const [pwdStealth, setPwdStealth] = React.useState('');
  const [pwdNuclear, setPwdNuclear] = React.useState('');
  const [pwdSaveStatus, setPwdSaveStatus] = React.useState('');

  const handleSavePasswords = async (e) => {
    e.preventDefault();
    setPwdSaveStatus('Saving...');
    try {
      await api.auth.setupPasswords({
        pwd_standard: pwdStandard,
        pwd_root: pwdRoot,
        pwd_stealth: pwdStealth,
        pwd_nuclear: pwdNuclear
      });
      setPwdSaveStatus('✅ Passwords Updated Successfully!');
      setTimeout(() => setPwdSaveStatus(''), 3000);
      setPwdStandard('');
      setPwdRoot('');
      setPwdStealth('');
      setPwdNuclear('');
    } catch (err) {
      setPwdSaveStatus('❌ Error: ' + err.message);
    }
  };

  const [onionRouting, setOnionRouting] = React.useState(true);
  const [obfuscation, setObfuscation] = React.useState('shadow-tls');
  const [exitNodePolicy, setExitNodePolicy] = React.useState('random');

  return (
    <div className="space-y-6 font-mono">
      <div>
        <h1 className="text-xl font-bold text-slate-100 flex items-center space-x-2">
          <span>Sovereign Mesh Global Configuration</span>
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-accent-primary/20 text-accent-primary border border-accent-primary/40">
            System Parameters
          </span>
        </h1>
        <p className="text-xs text-slate-400 mt-1 font-sans">
          Low-level cryptographic primitives, MTU sizing, and advanced traffic routing rules.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Advanced Traffic & Onion Routing */}
        <div className="p-5 rounded-2xl bg-dark-card border border-dark-border space-y-4 shadow-xl">
          <div className="flex items-center space-x-2 font-bold text-slate-100 text-sm">
            <Shield className="w-4 h-4 text-emerald-400" />
            <span>Onion Routing & Obfuscation</span>
          </div>
          <div className="space-y-3 text-xs">
            <div className="flex items-center justify-between p-3 rounded-lg bg-dark-canvas border border-dark-border">
              <div>
                <div className="font-semibold text-slate-200">Tor-Grade 3-Hop Circuits</div>
                <div className="text-[11px] text-slate-400">Layered Noise encryption across relays</div>
              </div>
              <input
                type="checkbox"
                checked={onionRouting}
                onChange={(e) => setOnionRouting(e.target.checked)}
                className="w-4 h-4 rounded text-accent-primary accent-accent-primary bg-dark-card border-dark-border"
              />
            </div>

            <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border space-y-2">
              <label className="block text-slate-300 font-semibold">Obfuscation Protocol</label>
              <select
                value={obfuscation}
                onChange={(e) => setObfuscation(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-dark-card border border-dark-border text-slate-200 text-xs focus:outline-none focus:border-accent-primary"
              >
                <option value="shadow-tls">ShadowTLS v3 (Mimic TLS 1.3 Handshake)</option>
                <option value="vless-reality">VLESS Reality (Zero-RTT Server Name Indication)</option>
                <option value="quic-masque">QUIC MASQUE (HTTP/3 Datagram Tunneling)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Global MTU & WireGuard Engine */}
        <div className="p-5 rounded-2xl bg-dark-card border border-dark-border space-y-4 shadow-xl">
          <div className="flex items-center space-x-2 font-bold text-slate-100 text-sm">
            <Cpu className="w-4 h-4 text-indigo-400" />
            <span>Kernel & Interface Parameters</span>
          </div>
          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border flex justify-between items-center">
              <div>
                <span className="text-slate-400 block">Default Interface MTU</span>
                <span className="text-slate-200 font-bold">1360 Bytes (DirectFrame Clamped)</span>
              </div>
              <span className="text-emerald-400 text-xs px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30">
                Optimized
              </span>
            </div>

            <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border flex justify-between items-center">
              <div>
                <span className="text-slate-400 block">Keepalive Interval</span>
                <span className="text-slate-200 font-bold">25 Seconds (Persistent NAT Hole-Punch)</span>
              </div>
              <span className="text-emerald-400 text-xs px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30">
                Active
              </span>
            </div>
          </div>
        </div>

        {/* Existing Crypto */}
        <div className="p-5 rounded-2xl bg-dark-card border border-dark-border space-y-4 shadow-xl">
          <div className="flex items-center space-x-2 font-bold text-slate-100 text-sm">
            <Shield className="w-4 h-4 text-accent-primary" />
            <span>Cryptographic Ciphersuites</span>
          </div>
          <div className="space-y-3 text-xs">
            <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border flex justify-between">
              <span className="text-slate-400">Tunnel Protocol:</span>
              <span className="text-accent-primary font-bold">Noise_IKpsk2_25519_ChaChaPoly</span>
            </div>
            <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border flex justify-between">
              <span className="text-slate-400">Key Exchange:</span>
              <span className="text-slate-200">Curve25519 (Clamped Scalar)</span>
            </div>
            <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border flex justify-between">
              <span className="text-slate-400">Symmetric Cipher:</span>
              <span className="text-slate-200">ChaCha20-Poly1305 (256-bit AEAD)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MainConsole() {
  const [activeTab, setActiveTab] = useState('overview');
  const [nodes, setNodes] = useState([]);
  const { logout } = useAuth();

  const loadNodes = React.useCallback(async () => {
    try {
      const list = await api.nodes.list();
      if (Array.isArray(list)) setNodes(list);
    } catch (e) {
      // ignore
    }
  }, []);

  // Polled, not loaded once. Node rows carry last_heartbeat, and reachability is
  // computed from it against the current clock: a list fetched at mount and never
  // refreshed ages out of the liveness window and reports the whole fleet down.
  React.useEffect(() => {
    loadNodes();
    const poll = setInterval(loadNodes, 30000);
    return () => clearInterval(poll);
  }, [loadNodes]);

  const nodeCount = nodes.length;
  const quarantinedCount = nodes.filter((n) => Boolean(n.is_quarantined)).length;

  // A node counts as reachable when the control plane heard from it within the last
  // minute, which is four of its fifteen-second heartbeat intervals.
  const reachableCount = nodes.filter((n) => {
    if (!n.last_heartbeat) return false;
    return Date.now() - new Date(n.last_heartbeat).getTime() < 60000;
  }).length;
  const highRiskCount = nodes.filter((n) => (n.risk_score || 0) > 75).length;

  const handleExecuteWipe = async () => {
    if (
      window.confirm(
        'FINAL WARNING: This is the Point of No Return. Executing will PERMANENTLY DESTROY the account and network assets. Execute?'
      )
    ) {
      try {
        await api.nuke.userSelfDestruct('DELETE MY ACCOUNT', true);
        alert('DESTRUCTION COMPLETE. System wiped. Logging out.');
        handleDisarmNuke();
        if (logout) logout();
      } catch (err) {
        alert(err.message || 'Wipe failed');
      }
    }
  };

  const [selectedNode, setSelectedNode] = useState(null);
  const [isEnrollModalOpen, setIsEnrollModalOpen] = useState(false);
  const [isSecretModalOpen, setIsSecretModalOpen] = useState(false);

  // Persistent Red Button State for NeroNuke (Visible on EVERY page when armed)
  const [nukeArmed, setNukeArmed] = useState(() => localStorage.getItem('nukeArmed') === 'true');
  const [nukeScheduledAt, setNukeScheduledAt] = useState(() => localStorage.getItem('nukeScheduledAt') || null);

  React.useEffect(() => {
    localStorage.setItem('nukeArmed', nukeArmed);
    if (nukeScheduledAt) {
      localStorage.setItem('nukeScheduledAt', nukeScheduledAt);
    } else {
      localStorage.removeItem('nukeScheduledAt');
    }
  }, [nukeArmed, nukeScheduledAt]);

  const handleArmNuke = (scheduledAt) => {
    setNukeArmed(true);
    setNukeScheduledAt(scheduledAt);
  };

  const handleDisarmNuke = () => {
    setNukeArmed(false);
    setNukeScheduledAt(null);
  };

  const renderActiveView = () => {
    switch (activeTab) {
      case 'overview':
        return <Overview onSelectNode={(node) => setSelectedNode(node)} onNavigateTab={(tab) => setActiveTab(tab)} />;
      case 'topology':
        return <Topology3D onSelectNode={(node) => setSelectedNode(node)} />;
      case 'nodes':
        return (
          <NodeMatrix
            onSelectNode={(node) => setSelectedNode(node)}
            onOpenEnrollModal={() => setIsEnrollModalOpen(true)}
          />
        );
      case 'onion':
        return <OnionObfuscationPanel />;
      case 'peering':
        return <PeeringManagement />;
      case 'geofencing':
        return <GeoFencingMap />;
      case 'apps':
        return <AppBundles />;
      case 'risk':
        return <BehavioralRiskDashboard onSelectNode={(node) => setSelectedNode(node)} />;
      case 'acls':
        return <SettingsACL />;
      case 'audit':
        return <AuditLogs />;
      case 'users':
        return <UserManagement />;
      case 'settings':
        return <MeshSettingsView />;
      case 'nuke':
        return (
          <NeroNukePanel
            nukeArmed={nukeArmed}
            nukeScheduledAt={nukeScheduledAt}
            onArmNuke={() => setNukeArmed(true)}
            onDisarmNuke={handleDisarmNuke}
            onOpenSecretModal={() => setIsSecretModalOpen(true)}
          />
        );
      default:
        return <Overview onSelectNode={(node) => setSelectedNode(node)} onNavigateTab={(tab) => setActiveTab(tab)} />;
    }
  };

  return (
    <div className="flex min-h-screen bg-dark-canvas text-slate-100 font-sans">
      {/* Persistent Enterprise Cyber Sidebar */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        nodeCount={nodeCount}
        reachableCount={reachableCount}
        quarantinedCount={quarantinedCount}
        highRiskCount={highRiskCount}
        nukeArmed={nukeArmed}
        nukeScheduledAt={nukeScheduledAt}
        onNukeClick={() => setActiveTab('nuke')}
        onExecuteWipe={handleExecuteWipe}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top HUD Header */}
        <Header onOpenEnrollModal={() => setIsEnrollModalOpen(true)} activeTab={activeTab} />

        {/* Dynamic Tab Body */}
        <main className="p-6 flex-1 max-w-7xl w-full mx-auto">
          <div className="mb-4">
            <DataSourceBanner />
          </div>
          <ErrorBoundary>{renderActiveView()}</ErrorBoundary>
        </main>
      </div>

      {/* Global Node Actions Slide-Over Drawer */}
      <NodeActions
        node={selectedNode}
        isOpen={!!selectedNode}
        onClose={() => setSelectedNode(null)}
        onNodeUpdated={(updated) => {
          setSelectedNode(updated);
          loadNodes();
        }}
        onNodeRevoked={() => {
          setSelectedNode(null);
          loadNodes();
        }}
        onNavigateTab={(tab) => setActiveTab(tab)}
      />

      {/* Cryptographic Profile & QR Code Modal */}
      <CryptoConfigModal
        isOpen={isEnrollModalOpen}
        onClose={() => setIsEnrollModalOpen(false)}
        onNodeEnrolled={(node) => {
          setSelectedNode(node);
          loadNodes();
        }}
      />

      {/* Steganographic Secret Access Modal (Tier 1b DMS) */}
      <NeroNukeSecretAccessModal
        isOpen={isSecretModalOpen}
        onClose={() => setIsSecretModalOpen(false)}
        onAuthenticated={() => {
          // Secret access successful
        }}
      />
    </div>
  );
}

function LoginPage() {
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const { login } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await login(username, password);
    } catch (err) {
      setError(err?.message || 'Invalid credentials. Access denied.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-dark-canvas font-sans px-4">
      <div className="w-full max-w-md p-8 rounded-2xl bg-dark-card border border-dark-border shadow-2xl space-y-6">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 mx-auto rounded-xl bg-accent-primary/10 border border-accent-primary/30 flex items-center justify-center text-accent-primary text-2xl shadow-lg glow-sky">
            🕸️
          </div>
          <h1 className="text-xl font-bold text-slate-100 font-mono tracking-wider">NeroNet Enterprise</h1>
          <p className="text-xs text-slate-400 font-mono">Sovereign Mesh Control Plane &mdash; v4.0</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="block text-slate-300 text-xs font-mono">Username</label>
            <input
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-dark-canvas border border-dark-border text-slate-100 placeholder-slate-600 text-xs font-mono focus:outline-none focus:border-accent-primary transition-colors"
              placeholder="admin"
              autoFocus
            />
          </div>

          <div className="space-y-1">
            <label className="block text-slate-300 text-xs font-mono">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-dark-canvas border border-dark-border text-slate-100 placeholder-slate-600 text-xs font-mono focus:outline-none focus:border-accent-primary transition-colors"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-red-950/40 border border-red-500/40 text-red-300 text-xs font-mono">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-xl bg-accent-primary hover:bg-sky-400 text-slate-950 font-bold text-xs font-mono tracking-wider uppercase transition-all shadow-lg shadow-sky-500/20 disabled:opacity-50 flex items-center justify-center space-x-2 cursor-pointer"
          >
            <span>{loading ? 'Authenticating...' : '🔐 Sign In'}</span>
          </button>
        </form>

        <div className="text-center pt-2 border-t border-dark-border/80">
          <p className="text-[11px] text-slate-500 font-mono">
            {/* This read "Zero-Knowledge Cryptographic Authentication • Ed25519".
                Console sign-in is a password verified with bcrypt against a hash,
                and the session is a signed JWT. Ed25519 is used for node identity
                and federation, not for logging in here. */}
            Password sign-in &bull; bcrypt &bull; signed session token
          </p>
        </div>
      </div>
    </div>
  );
}

function AppContent() {
  const { token, user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-dark-canvas text-slate-100 font-mono">
        <div className="flex items-center space-x-3 mb-3">
          <div className="w-5 h-5 border-2 border-accent-primary border-t-transparent rounded-full animate-spin"></div>
          <span className="text-xs font-bold tracking-widest text-accent-primary uppercase">
            Verifying Cryptographic Session...
          </span>
        </div>
        <p className="text-[11px] text-slate-500 font-sans">Checking JWT signature and zero-trust mesh authority</p>
      </div>
    );
  }

  if (!token || !user) {
    return <LoginPage />;
  }

  return <MainConsole />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ErrorBoundary>
  );
}
