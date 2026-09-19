import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import {
  FileText,
  Search,
  Download,
  ShieldAlert,
  ShieldCheck,
  Code,
  Copy,
  Check,
  X,
  Clock,
  Filter,
  Layers
} from 'lucide-react';

export default function AuditLogs() {
  const [logs, setLogs] = useState([]);
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState('ALL');
  const [selectedLog, setSelectedLog] = useState(null);
  const [copiedJson, setCopiedJson] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadAudit() {
      try {
        const events = await api.audit.list();
        setLogs(events);
      } catch (err) {
        console.error('Failed to load audit logs:', err);
      } finally {
        setLoading(false);
      }
    }
    loadAudit();
  }, []);

  const filteredLogs = logs.filter((log) => {
    const matchesSearch =
      log.message.toLowerCase().includes(search.toLowerCase()) ||
      log.event_type.toLowerCase().includes(search.toLowerCase()) ||
      (log.actor_username && log.actor_username.toLowerCase().includes(search.toLowerCase()));

    const matchesSeverity = severityFilter === 'ALL' || log.severity === severityFilter;

    return matchesSearch && matchesSeverity;
  });

  const handleExportCsv = () => {
    const headers = ['ID', 'Timestamp', 'Severity', 'EventType', 'Actor', 'Target', 'Message', 'IP'];
    const rows = filteredLogs.map((l) => [
      l.id,
      `"${l.created_at}"`,
      l.severity,
      l.event_type,
      `"${l.actor_username || ''}"`,
      `"${l.target_id || ''}"`,
      `"${l.message.replace(/"/g, '""')}"`,
      l.ip_address || ''
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `neronet_audit_log_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  const handleCopyJson = (jsonString) => {
    navigator.clipboard.writeText(jsonString);
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 2000);
  };

  const getSeverityBadge = (severity) => {
    switch (severity) {
      case 'critical':
        return (
          <span className="px-2 py-0.5 rounded bg-danger/20 text-danger border border-danger/40 font-bold text-[10px]">
            CRITICAL
          </span>
        );
      case 'error':
        return (
          <span className="px-2 py-0.5 rounded bg-danger/15 text-danger border border-danger/30 font-bold text-[10px]">
            ERROR
          </span>
        );
      case 'warn':
        return (
          <span className="px-2 py-0.5 rounded bg-warning/20 text-warning border border-warning/40 font-bold text-[10px]">
            WARN
          </span>
        );
      case 'info':
      default:
        return (
          <span className="px-2 py-0.5 rounded bg-accent/15 text-accent border border-accent/30 font-bold text-[10px]">
            INFO
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-content flex items-center space-x-2">
            <span>Forensic Security Audit & Event Ledger</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-accent/20 text-accent border border-accent/40">
              Immutable Append-Only
            </span>
          </h1>
          <p className="text-xs text-muted mt-1">
            Real-time telemetry stream capturing authentication, cryptographic handshakes, posture violations, and node
            lifecycle events.
          </p>
        </div>

        <button
          onClick={handleExportCsv}
          className="flex items-center space-x-2 px-4 py-2 rounded-lg bg-surface-raised border border-border text-content hover:text-white hover:border-accent/50 text-xs font-mono transition-all shadow-lg"
        >
          <Download className="w-4 h-4 text-accent" />
          <span>Export CSV Ledger</span>
        </button>
      </div>

      {/* Filter Toolbar */}
      <div className="p-3 rounded-xl bg-surface-raised border border-border flex flex-wrap items-center justify-between gap-3 text-xs font-mono">
        <div className="relative w-full max-w-sm">
          <Search className="w-3.5 h-3.5 text-subtle absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search event message, actor, type..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 bg-surface border border-border rounded-lg text-content placeholder-subtle focus:outline-none focus:border-accent text-xs font-mono"
          />
        </div>

        <div className="flex items-center space-x-2">
          <span className="text-subtle">Severity:</span>
          <select
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
            className="px-2.5 py-1.5 bg-surface border border-border rounded text-content focus:outline-none focus:border-accent text-xs font-mono"
          >
            <option value="ALL">All Severities</option>
            <option value="critical">Critical</option>
            <option value="warn">Warning</option>
            <option value="info">Info</option>
          </select>
        </div>
      </div>

      {/* Audit Log Table */}
      <div className="rounded-xl bg-surface-raised border border-border overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-mono">
            <thead className="bg-surface text-muted uppercase text-[10px] tracking-wider border-b border-border">
              <tr>
                <th className="p-3.5">Timestamp</th>
                <th className="p-3.5">Severity</th>
                <th className="p-3.5">Event Type</th>
                <th className="p-3.5">Actor</th>
                <th className="p-3.5">Message / Rationale</th>
                <th className="p-3.5 text-right">Payload</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filteredLogs.map((log) => (
                <tr
                  key={log.id}
                  onClick={() => setSelectedLog(log)}
                  className="hover:bg-surface-hover cursor-pointer transition-colors"
                >
                  <td className="p-3.5 text-muted whitespace-nowrap">
                    {new Date(log.created_at).toLocaleTimeString()}
                  </td>
                  <td className="p-3.5">{getSeverityBadge(log.severity)}</td>
                  <td className="p-3.5 font-bold text-content">{log.event_type}</td>
                  <td className="p-3.5 text-accent">{log.actor_username || 'System'}</td>
                  <td className="p-3.5 text-muted max-w-md truncate">{log.message}</td>
                  <td className="p-3.5 text-right">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedLog(log);
                      }}
                      className="px-2.5 py-1 rounded bg-surface border border-border text-muted hover:text-accent hover:border-accent/40 text-xs transition-colors flex items-center space-x-1 ml-auto"
                    >
                      <Code className="w-3.5 h-3.5" />
                      <span>Inspect</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Slide-over JSON Payload Inspector */}
      {selectedLog && (
        <div className="fixed inset-0 z-50 overflow-hidden bg-black/60 backdrop-blur-xs flex justify-end">
          <div className="w-full max-w-lg bg-surface-raised border-l border-border h-full flex flex-col shadow-2xl p-6 space-y-4 overflow-y-auto">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div className="flex items-center space-x-2 font-bold text-content font-mono text-sm">
                <Code className="w-4 h-4 text-accent" />
                <span>Forensic JSON Metadata Inspector</span>
              </div>
              <button onClick={() => setSelectedLog(null)} className="text-muted hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-2 text-xs font-mono">
              <div className="p-3 rounded-lg bg-surface border border-border space-y-1">
                <div>
                  Event ID: <span className="text-content font-bold">{selectedLog.id}</span>
                </div>
                <div>
                  Event Type: <span className="text-accent font-bold">{selectedLog.event_type}</span>
                </div>
                <div>
                  Actor: <span className="text-success font-bold">{selectedLog.actor_username || 'System'}</span>
                </div>
                <div>
                  IP Address: <span className="text-muted">{selectedLog.ip_address || '100.64.0.1'}</span>
                </div>
                <div>
                  Timestamp: <span className="text-muted">{selectedLog.created_at}</span>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-muted text-xs">Raw JSON Payload:</span>
                <button
                  onClick={() => handleCopyJson(selectedLog.metadata_json)}
                  className="flex items-center space-x-1 px-2.5 py-1 rounded bg-surface border border-border text-muted hover:text-white text-xs"
                >
                  {copiedJson ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedJson ? 'Copied' : 'Copy Payload'}</span>
                </button>
              </div>

              <pre className="p-4 rounded-xl bg-surface border border-border text-accent font-mono text-xs overflow-x-auto leading-relaxed">
                {(() => {
                  try {
                    return JSON.stringify(JSON.parse(selectedLog.metadata_json), null, 2);
                  } catch (e) {
                    return selectedLog.metadata_json;
                  }
                })()}
              </pre>
            </div>

            <div className="flex justify-end pt-4 border-t border-border">
              <button
                onClick={() => setSelectedLog(null)}
                className="px-4 py-2 rounded-lg bg-border text-muted text-xs font-mono"
              >
                Close Inspector
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
