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
import CloudPc from './components/CloudPc';
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
import { parseFeatures } from './services/features';
import { Settings, Shield, Terminal, Cpu, CheckCircle2, AlertTriangle } from 'lucide-react';
import { SkipLink } from './ui';

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
        <div className="min-h-screen flex items-center justify-center bg-surface text-content font-mono p-6">
          <div className="max-w-xl w-full p-6 rounded-2xl bg-surface-raised border border-danger/50 shadow-2xl space-y-4">
            <div className="flex items-center space-x-3 text-danger">
              <AlertTriangle className="w-6 h-6" />
              <h2 className="text-lg font-bold">Console Render Error</h2>
            </div>
            <p className="text-xs text-muted">An unexpected error occurred while rendering the management console:</p>
            <pre className="p-3 bg-surface border border-border rounded-lg text-danger text-xs overflow-x-auto whitespace-pre-wrap">
              {this.state.error?.toString()}
            </pre>
            <div className="flex space-x-3 pt-2">
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-accent text-accent-contrast font-bold rounded-lg text-xs hover:brightness-110 cursor-pointer"
              >
                Reload Page
              </button>
              <button
                onClick={() => {
                  localStorage.clear();
                  window.location.reload();
                }}
                className="px-4 py-2 bg-border text-muted hover:text-white font-bold rounded-lg text-xs cursor-pointer"
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
            <span>Onion Routing & Obfuscation</span>
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
            <span>Kernel & Interface Parameters</span>
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

function MainConsole() {
  const [activeTab, setActiveTab] = useState('overview');
  const [nodes, setNodes] = useState([]);
  const [features, setFeatures] = useState(() => parseFeatures(null));
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

  // Loaded once per session. The server owns the answer; until it arrives every
  // optional entry stays hidden.
  React.useEffect(() => {
    let cancelled = false;
    api.features.get().then((f) => {
      if (!cancelled) setFeatures(f);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
      case 'cloudpc':
        return features.cloud_pc ? <CloudPc /> : null;
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
    <div className="flex min-h-screen bg-surface text-content font-sans">
      {/* First stop in the tab order: past the whole sidebar, to the page. */}
      <SkipLink />
      {/* Persistent navigation */}
      <Sidebar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        features={features}
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

        {/* Dynamic Tab Body. tabIndex -1 so the skip link moves focus here and
            not only the viewport. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="p-6 flex-1 max-w-7xl w-full mx-auto focus-visible:outline-focus"
        >
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
    <div className="min-h-screen flex items-center justify-center bg-surface font-sans px-4">
      <div className="w-full max-w-md p-8 rounded-2xl bg-surface-raised border border-border shadow-2xl space-y-6">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 mx-auto rounded-xl bg-accent/10 border border-accent/30 flex items-center justify-center text-accent text-2xl shadow-lg">
            🕸️
          </div>
          <h1 className="text-xl font-bold text-content font-mono tracking-wider">NeroNet Enterprise</h1>
          <p className="text-xs text-muted font-mono">Sovereign Mesh Control Plane &mdash; v4.0</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="block text-muted text-xs font-mono">Username</label>
            <input
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-surface border border-border text-content placeholder-subtle text-xs font-mono focus:outline-none focus:border-accent transition-colors"
              placeholder="admin"
              autoFocus
            />
          </div>

          <div className="space-y-1">
            <label className="block text-muted text-xs font-mono">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-surface border border-border text-content placeholder-subtle text-xs font-mono focus:outline-none focus:border-accent transition-colors"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="p-3 rounded-lg bg-danger/40 border border-danger/40 text-danger text-xs font-mono">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 px-4 rounded-xl bg-accent hover:bg-accent text-accent-contrast font-bold text-xs font-mono tracking-wider uppercase transition-all shadow-lg disabled:opacity-50 flex items-center justify-center space-x-2 cursor-pointer"
          >
            <span>{loading ? 'Authenticating...' : '🔐 Sign In'}</span>
          </button>
        </form>

        <div className="text-center pt-2 border-t border-border/80">
          <p className="text-[11px] text-subtle font-mono">
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
      <div className="min-h-screen flex flex-col items-center justify-center bg-surface text-content font-mono">
        <div className="flex items-center space-x-3 mb-3">
          <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin"></div>
          <span className="text-xs font-bold tracking-widest text-accent uppercase">
            Verifying Cryptographic Session...
          </span>
        </div>
        <p className="text-[11px] text-subtle font-sans">Checking JWT signature and zero-trust mesh authority</p>
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
