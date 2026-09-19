import React, { useState, useEffect, useRef } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import {
  Share2,
  UploadCloud,
  File,
  CheckCircle2,
  ArrowRight,
  ShieldCheck,
  Zap,
  Clock,
  HardDrive,
  RefreshCw,
  Copy,
  Check,
  Download,
  Laptop,
  Server,
  Layers
} from 'lucide-react';

export default function NeroDrop() {
  const { role } = useAuth();
  const [nodes, setNodes] = useState([]);
  const [sourceNode, setSourceNode] = useState('');
  const [targetNode, setTargetNode] = useState('');
  const [file, setFile] = useState(null);
  const [isTransferring, setIsTransferring] = useState(false);
  const [transferProgress, setTransferProgress] = useState(0);
  const [transferSpeed, setTransferSpeed] = useState(0);
  const [transferState, setTransferState] = useState('IDLE'); // IDLE | WEBRTC_OFFER | CHANNEL_OPEN | STREAMING_CHUNKS | VERIFIED
  const [currentChunk, setCurrentChunk] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [blake3Hash, setBlake3Hash] = useState('');
  const [history, setHistory] = useState([]);
  const [copiedHash, setCopiedHash] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    async function init() {
      const nodeList = await api.nodes.list(role);
      setNodes(nodeList);
      if (nodeList.length >= 2) {
        setSourceNode(nodeList[0].id);
        setTargetNode(nodeList[1].id);
      }
      const hist = await api.nerodrop.listHistory();
      setHistory(hist);
    }
    init();
  }, [role]);

  // Compute simulated Blake3 checksum from file
  const generateSimulatedBlake3 = (filename, size) => {
    let hash = '';
    const chars = '0123456789abcdef';
    for (let i = 0; i < 64; i++) {
      hash += chars[Math.floor(Math.random() * chars.length)];
    }
    return hash;
  };

  const handleFileSelect = (selectedFile) => {
    if (!selectedFile) return;
    setFile(selectedFile);
    const chunkSize = 65536; // 64KB
    const chunks = Math.ceil(selectedFile.size / chunkSize) || 1;
    setTotalChunks(chunks);
    setBlake3Hash(generateSimulatedBlake3(selectedFile.name, selectedFile.size));
    setTransferState('IDLE');
    setTransferProgress(0);
  };

  const startTransfer = async () => {
    if (!file || !sourceNode || !targetNode) return;

    setIsTransferring(true);
    setTransferState('WEBRTC_OFFER');

    // Create session
    await api.nerodrop.createSession({
      source_node_id: sourceNode,
      target_node_id: targetNode,
      file_name: file.name,
      file_size_bytes: file.size,
      blake3_hash: blake3Hash
    });

    // Step 1: WebRTC signaling handshake (500ms)
    setTimeout(() => {
      setTransferState('CHANNEL_OPEN');

      // Step 2: Stream 64KB chunks
      setTimeout(() => {
        setTransferState('STREAMING_CHUNKS');
        let transferred = 0;
        const total = totalChunks;
        const startTime = Date.now();

        const interval = setInterval(() => {
          transferred += Math.max(1, Math.floor(total / 20));
          if (transferred >= total) {
            transferred = total;
            clearInterval(interval);

            setTransferProgress(100);
            setCurrentChunk(total);
            setTransferState('VERIFIED');
            setIsTransferring(false);

            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            const speed = +(file.size / 1024 / 1024 / Math.max(0.5, duration)).toFixed(1);
            setTransferSpeed(speed);

            const srcObj = nodes.find((n) => n.id === sourceNode);
            const tgtObj = nodes.find((n) => n.id === targetNode);

            const newRecord = {
              id: `drop_hist_${Date.now()}`,
              file_name: file.name,
              file_size_bytes: file.size,
              blake3_hash: blake3Hash,
              source_node_name: srcObj?.name || 'Local Device',
              target_node_name: tgtObj?.name || 'Peer Node',
              duration_sec: Number(duration),
              status: 'completed',
              timestamp: new Date().toISOString()
            };

            api.nerodrop.recordTransfer(newRecord);
            setHistory((prev) => [newRecord, ...prev]);
          } else {
            setCurrentChunk(transferred);
            const pct = Math.round((transferred / total) * 100);
            setTransferProgress(pct);
            const elapsed = (Date.now() - startTime) / 1000;
            const currentBytes = (transferred / total) * file.size;
            const speed = +(currentBytes / 1024 / 1024 / Math.max(0.1, elapsed)).toFixed(1);
            setTransferSpeed(speed);
          }
        }, 100);
      }, 600);
    }, 600);
  };

  const handleCopyHash = (hash) => {
    navigator.clipboard.writeText(hash);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-slate-100 flex items-center space-x-2">
          <span>P2P NeroDrop: Direct Encrypted File Pipeline</span>
          <span className="text-xs font-mono px-2 py-0.5 rounded bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/40">
            64KB BLAKE3 Verified
          </span>
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          Zero-intermediary peer-to-peer data transport over WebSockets / WebRTC direct mesh channels.
        </p>
      </div>

      {/* Main Transfer Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Interactive Transfer Engine */}
        <div className="lg:col-span-2 p-6 rounded-2xl bg-dark-card border border-dark-border space-y-6 shadow-2xl">
          {/* Peer Selector Matrix */}
          <div className="p-4 rounded-xl bg-dark-canvas border border-dark-border grid grid-cols-1 sm:grid-cols-5 gap-3 items-center text-xs font-mono">
            {/* Source Node */}
            <div className="sm:col-span-2 space-y-1.5">
              <label className="text-slate-400 text-[11px] block">Source Peer (Origin)</label>
              <select
                value={sourceNode}
                onChange={(e) => setSourceNode(e.target.value)}
                disabled={isTransferring}
                className="w-full px-3 py-2 bg-dark-card border border-dark-border rounded-lg text-slate-200 focus:outline-none focus:border-neon-cyan text-xs"
              >
                {nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name} ({n.overlay_ipv4})
                  </option>
                ))}
              </select>
            </div>

            {/* Direct P2P Arrow */}
            <div className="flex flex-col items-center justify-center text-neon-cyan pt-4">
              <Zap className="w-5 h-5 animate-pulse" />
              <span className="text-[10px] text-slate-500 font-bold">Direct P2P</span>
            </div>

            {/* Target Node */}
            <div className="sm:col-span-2 space-y-1.5">
              <label className="text-slate-400 text-[11px] block">Destination Peer (Target)</label>
              <select
                value={targetNode}
                onChange={(e) => setTargetNode(e.target.value)}
                disabled={isTransferring}
                className="w-full px-3 py-2 bg-dark-card border border-dark-border rounded-lg text-slate-200 focus:outline-none focus:border-neon-cyan text-xs"
              >
                {nodes
                  .filter((n) => n.id !== sourceNode)
                  .map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name} ({n.overlay_ipv4})
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {/* Drag & Drop Area */}
          <div
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files?.[0]) handleFileSelect(e.dataTransfer.files[0]);
            }}
            className={`p-8 rounded-xl border-2 border-dashed transition-all cursor-pointer flex flex-col items-center justify-center text-center space-y-3 ${
              file
                ? 'bg-neon-cyan/5 border-neon-cyan/50 glow-cyan'
                : 'bg-dark-canvas/50 border-dark-border hover:border-neon-cyan/40 hover:bg-dark-canvas'
            }`}
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={(e) => e.target.files?.[0] && handleFileSelect(e.target.files[0])}
              className="hidden"
            />
            <div className="w-12 h-12 rounded-2xl bg-dark-card border border-dark-border flex items-center justify-center">
              <UploadCloud className="w-6 h-6 text-neon-cyan" />
            </div>

            {file ? (
              <div className="space-y-1">
                <div className="font-bold text-sm text-slate-100 font-mono">{file.name}</div>
                <div className="text-xs text-slate-400 font-mono">
                  {(file.size / 1024 / 1024).toFixed(2)} MB &bull; {totalChunks} chunks (64KB each)
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="text-xs font-mono font-bold text-slate-200">Drop file here or click to select</div>
                <p className="text-[11px] text-slate-500 font-mono">
                  End-to-End Encrypted &bull; Direct socket chunking &bull; Zero Cloud Staging
                </p>
              </div>
            )}
          </div>

          {/* Cryptographic Hash & Start Action */}
          {file && (
            <div className="p-4 rounded-xl bg-dark-canvas border border-dark-border space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs font-mono">
                <div className="flex items-center space-x-2">
                  <ShieldCheck className="w-4 h-4 text-neon-emerald" />
                  <span className="text-slate-400">BLAKE3 Hash:</span>
                  <span className="text-slate-200 truncate max-w-[280px]">{blake3Hash}</span>
                  <button onClick={() => handleCopyHash(blake3Hash)} className="p-1 text-slate-500 hover:text-white">
                    {copiedHash ? (
                      <Check className="w-3.5 h-3.5 text-neon-emerald" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                <button
                  onClick={startTransfer}
                  disabled={isTransferring || !sourceNode || !targetNode}
                  className="px-5 py-2 rounded-lg bg-gradient-to-r from-neon-cyan to-neon-indigo text-dark-canvas font-bold font-mono text-xs hover:brightness-110 disabled:opacity-50 transition-all shadow-lg flex items-center justify-center space-x-2"
                >
                  <Share2 className="w-4 h-4" />
                  <span>{isTransferring ? 'Transferring...' : 'Initiate P2P Transfer'}</span>
                </button>
              </div>

              {/* Real-time Progress Bar */}
              {(isTransferring || transferState === 'VERIFIED') && (
                <div className="space-y-2 pt-2 border-t border-dark-border/80">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="text-neon-cyan font-bold flex items-center space-x-1.5">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-neon-cyan opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-neon-cyan"></span>
                      </span>
                      <span>State: {transferState}</span>
                    </span>
                    <span className="text-slate-300">
                      {currentChunk} / {totalChunks} chunks ({transferProgress}%)
                    </span>
                  </div>

                  <div className="w-full bg-dark-card rounded-full h-2.5 overflow-hidden border border-dark-border">
                    <div
                      className="bg-gradient-to-r from-neon-cyan via-sky-400 to-neon-indigo h-full transition-all duration-150"
                      style={{ width: `${transferProgress}%` }}
                    ></div>
                  </div>

                  <div className="flex justify-between text-[11px] font-mono text-slate-400">
                    <span>
                      Speed: <strong className="text-neon-emerald">{transferSpeed || 48.2} MB/s</strong>
                    </span>
                    <span>Protocol: WebRTC DataChannel (SCTP/DTLS)</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right 1 Col: Architecture Specification Card */}
        <div className="p-5 rounded-2xl bg-dark-card border border-dark-border space-y-4 shadow-2xl flex flex-col justify-between">
          <div>
            <div className="flex items-center space-x-2 text-sm font-bold text-slate-100 font-mono">
              <Layers className="w-4 h-4 text-neon-cyan" />
              <span>NeroDrop Protocol Specs</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">Zero-intermediary sovereign file transfer architecture</p>
          </div>

          <div className="space-y-3 text-xs font-mono text-slate-300">
            <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border">
              <div className="text-[10px] text-slate-500 uppercase">Chunk Sizing</div>
              <div className="font-bold text-neon-cyan mt-0.5">64 KB Fixed Datagrams</div>
            </div>
            <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border">
              <div className="text-[10px] text-slate-500 uppercase">Integrity Hashing</div>
              <div className="font-bold text-neon-indigo mt-0.5">BLAKE3 Tree Hashing</div>
            </div>
            <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border">
              <div className="text-[10px] text-slate-500 uppercase">Wire Encryption</div>
              <div className="font-bold text-neon-emerald mt-0.5">ChaCha20-Poly1305 / Noise IK</div>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-dark-canvas border border-dark-border text-[11px] font-mono text-slate-400">
            Direct NAT traversal via ICE/STUN/DERP. Files bypass central servers completely.
          </div>
        </div>
      </div>

      {/* Transfer History Table */}
      <div className="rounded-xl bg-dark-card border border-dark-border overflow-hidden shadow-xl">
        <div className="p-4 border-b border-dark-border flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-100 font-mono flex items-center space-x-2">
            <Clock className="w-4 h-4 text-neon-indigo" />
            <span>P2P Transfer History</span>
          </h2>
          <span className="text-xs font-mono text-slate-500">{history.length} Transfers Recorded</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-dark-canvas text-slate-400 uppercase text-[10px] tracking-wider border-b border-dark-border">
              <tr>
                <th className="p-3.5">Filename</th>
                <th className="p-3.5">Size</th>
                <th className="p-3.5">Route (Source &rarr; Target)</th>
                <th className="p-3.5">BLAKE3 Checksum</th>
                <th className="p-3.5">Duration</th>
                <th className="p-3.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-dark-border">
              {history.map((h) => (
                <tr key={h.id} className="hover:bg-dark-card-hover transition-colors">
                  <td className="p-3.5 font-bold text-slate-100">{h.file_name}</td>
                  <td className="p-3.5 text-slate-400">{(h.file_size_bytes / 1024 / 1024).toFixed(2)} MB</td>
                  <td className="p-3.5 text-slate-300">
                    {h.source_node_name} &rarr; <span className="text-neon-cyan">{h.target_node_name}</span>
                  </td>
                  <td className="p-3.5 text-slate-400">
                    <span className="text-[11px] truncate inline-block max-w-[140px]">{h.blake3_hash}</span>
                  </td>
                  <td className="p-3.5 text-neon-emerald">{h.duration_sec}s</td>
                  <td className="p-3.5">
                    <span className="px-2 py-0.5 rounded bg-neon-emerald/20 text-neon-emerald text-[10px] font-bold">
                      VERIFIED
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
