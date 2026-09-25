const dgram = require('node:dgram');
const net = require('node:net');
const os = require('node:os');
const logger = require('../utils/logger');
const { getPgPool } = require('../db/index');

const SEVERITY_MAP = {
  critical: 2,
  error: 3,
  warn: 4,
  info: 6
};

/**
 * Format an audit event into an RFC 5424 compliant Syslog message.
 * Reference: RFC 5424 - The Syslog Protocol
 */
function formatSyslogRFC5424(event, { hostname = os.hostname(), appName = 'neronet', procId = process.pid } = {}) {
  const facility = 1; // User-level messages
  const severity = SEVERITY_MAP[event.severity] || 6;
  const pri = facility * 8 + severity;

  const timestamp = event.created_at instanceof Date ? event.created_at.toISOString() : new Date().toISOString();
  const msgId = event.event_type || 'AUDIT';

  // Structured Data (SD-ELEMENT)
  const sdParams = [
    `seq="${event.sequence_num || 0}"`,
    `event_type="${event.event_type}"`,
    `severity="${event.severity}"`,
    `actor="${event.actor_username || 'system'}"`,
    `hash="${event.entry_hash || ''}"`
  ];
  if (event.target_id) sdParams.push(`target_id="${event.target_id}"`);
  if (event.ip_address) sdParams.push(`ip="${event.ip_address}"`);

  const structuredData = `[neronet@55555 ${sdParams.join(' ')}]`;
  const message = event.message || '';

  return `<${pri}>1 ${timestamp} ${hostname} ${appName} ${procId} ${msgId} ${structuredData} ${message}`;
}

class SiemExporter {
  /**
   * Forward an event to all configured and enabled SIEM destinations.
   */
  static async forwardEvent(event) {
    try {
      const pool = getPgPool();
      const destRes = await pool.query('SELECT * FROM audit_siem_destinations WHERE enabled = TRUE');
      if (destRes.rows.length === 0) return;

      const syslogMsg = formatSyslogRFC5424(event);

      for (const dest of destRes.rows) {
        try {
          await SiemExporter.sendToDestination(dest, syslogMsg, event);
        } catch (err) {
          logger.warn(`Failed forwarding audit event to SIEM '${dest.name}': ${err.message}`);
        }
      }
    } catch (err) {
      // SIEM export failures must not crash the caller
      logger.error('SIEM export dispatcher error:', err.message);
    }
  }

  /**
   * Send a syslog message to a specific destination endpoint.
   */
  static async sendToDestination(dest, syslogMsg, event) {
    const { protocol, endpoint } = dest;

    if (protocol === 'udp') {
      const [host, portStr] = endpoint.split(':');
      const port = parseInt(portStr, 10) || 514;
      const client = dgram.createSocket('udp4');
      const buf = Buffer.from(syslogMsg, 'utf8');

      return new Promise((resolve, reject) => {
        client.send(buf, 0, buf.length, port, host, (err) => {
          client.close();
          if (err) reject(err);
          else resolve();
        });
      });
    }

    if (protocol === 'tcp') {
      const [host, portStr] = endpoint.split(':');
      const port = parseInt(portStr, 10) || 514;

      return new Promise((resolve, reject) => {
        const client = net.createConnection({ host, port, timeout: 3000 }, () => {
          client.end(syslogMsg + '\n');
        });
        client.on('finish', () => resolve());
        client.on('error', (err) => reject(err));
        client.on('timeout', () => {
          client.destroy();
          reject(new Error('TCP connection to SIEM timed out'));
        });
      });
    }

    // Webhook destination
    if (protocol === 'webhook') {
      const body = dest.format === 'rfc5424' ? syslogMsg : JSON.stringify({ syslog: syslogMsg, event });

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': dest.format === 'rfc5424' ? 'application/octet-stream' : 'application/json' },
        body
      });
      if (!res.ok) {
        throw new Error(`SIEM webhook HTTP status ${res.status}`);
      }
    }
  }
}

module.exports = {
  SiemExporter,
  formatSyslogRFC5424
};
