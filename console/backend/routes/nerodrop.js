const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDatabase } = require('../db/index');
const { authenticateToken } = require('../middleware/auth');
const { logAuditEvent } = require('../utils/audit');

router.use(authenticateToken);

function formatSession(row) {
  if (!row) return null;
  return {
    session_id: row.id,
    id: row.id,
    user_id: row.user_id,
    sender_id: row.user_id,
    source_node_id: row.source_node_id,
    target_node_id: row.target_node_id,
    file_name: row.file_name,
    file_size_bytes: row.file_size_bytes,
    file_type: row.file_type || 'application/octet-stream',
    blake3_hash: row.blake3_hash,
    chunk_size_bytes: row.chunk_size_bytes || 65536,
    total_chunks: row.total_chunks,
    transferred_chunks: row.transferred_chunks || 0,
    bytes_transferred: row.bytes_transferred || 0,
    status: row.status,
    webrtc_signal:
      typeof row.webrtc_signal_json === 'string' ? JSON.parse(row.webrtc_signal_json || '{}') : row.webrtc_signal_json,
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

// 1. Create NeroDrop P2P Transfer Session
router.post('/session', (req, res) => {
  const { target_node_id, file_name, file_size_bytes, blake3_hash, file_type, source_node_id } = req.body || {};

  if (!target_node_id || !file_name) {
    return res.status(400).json({ error: 'Missing target_node_id or file_name' });
  }

  const size = file_size_bytes !== undefined ? file_size_bytes : 0;
  if (size < 0) {
    return res.status(400).json({ error: 'Invalid file size' });
  }

  const db = getDatabase();
  const targetNode = db.prepare('SELECT id, user_id FROM nodes WHERE id = ?').get(target_node_id);
  if (!targetNode) {
    return res.status(404).json({ error: 'Target node not found' });
  }

  let srcNodeId = source_node_id;
  if (!srcNodeId) {
    const userNode = db.prepare('SELECT id FROM nodes WHERE user_id = ? LIMIT 1').get(req.user.id);
    srcNodeId = userNode ? userNode.id : target_node_id;
  }

  const sid = `drop-${uuidv4().substring(0, 8)}`;
  const chunkSize = 65536;
  const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
  const b3 =
    blake3_hash ||
    crypto
      .createHash('sha256')
      .update(file_name + Date.now())
      .digest('hex');

  const webrtcSignal = {
    sdp: `v=0\r\no=NeroDrop ${sid} 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n`,
    ice_candidates: [{ candidate: 'candidate:1 1 UDP 2130706431 127.0.0.1 50000 typ host' }]
  };

  db.prepare(
    `
    INSERT INTO nerodrop_sessions (
      id, user_id, source_node_id, target_node_id, file_name,
      file_size_bytes, file_type, blake3_hash, chunk_size_bytes,
      total_chunks, transferred_chunks, bytes_transferred, status,
      webrtc_signal_json, started_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, 0, 0, 'ready',
      ?, datetime('now')
    )
  `
  ).run(
    sid,
    req.user.id,
    srcNodeId,
    target_node_id,
    file_name,
    size,
    file_type || 'application/octet-stream',
    b3,
    chunkSize,
    totalChunks,
    JSON.stringify(webrtcSignal)
  );

  logAuditEvent({
    eventType: 'NERODROP_SESSION_INIT',
    severity: 'info',
    actorUserId: req.user.id,
    actorUsername: req.user.username,
    targetId: sid,
    targetType: 'nerodrop',
    message: `NeroDrop transfer session initialized for ${file_name}`,
    ipAddress: req.ip
  });

  const created = formatSession(db.prepare('SELECT * FROM nerodrop_sessions WHERE id = ?').get(sid));
  return res.status(201).json(created);
});

// 2. List Transfers / Sessions
function listTransfersHandler(req, res) {
  const db = getDatabase();
  let rows;
  if (req.user.role === 'super-admin') {
    rows = db.prepare('SELECT * FROM nerodrop_sessions ORDER BY created_at DESC').all();
  } else {
    rows = db.prepare('SELECT * FROM nerodrop_sessions WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  }
  const transfers = rows.map(formatSession);
  return res.status(200).json({ transfers, sessions: transfers, total: transfers.length });
}

router.get('/transfers', listTransfersHandler);
router.get('/sessions', listTransfersHandler);

// 3. Get Transfer By ID
function getTransferHandler(req, res) {
  const db = getDatabase();
  const session = db.prepare('SELECT * FROM nerodrop_sessions WHERE id = ?').get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Transfer session not found' });
  }
  if (req.user.role !== 'super-admin' && session.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access forbidden' });
  }
  return res.status(200).json({ session: formatSession(session) });
}

router.get('/transfers/:id', getTransferHandler);
router.get('/session/:id', getTransferHandler);

// 4. Update Transfer Progress
function updateProgressHandler(req, res) {
  const { transferred_chunks, bytes_transferred, status } = req.body || {};
  const db = getDatabase();
  const session = db.prepare('SELECT * FROM nerodrop_sessions WHERE id = ?').get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Transfer session not found' });
  }
  if (req.user.role !== 'super-admin' && session.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access forbidden' });
  }

  const newStatus = status || (transferred_chunks >= session.total_chunks ? 'completed' : 'transferring');
  const completedAt = newStatus === 'completed' ? "datetime('now')" : null;

  db.prepare(
    `
    UPDATE nerodrop_sessions SET
      transferred_chunks = COALESCE(?, transferred_chunks),
      bytes_transferred = COALESCE(?, bytes_transferred),
      status = ?,
      completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE completed_at END,
      updated_at = datetime('now')
    WHERE id = ?
  `
  ).run(
    transferred_chunks !== undefined ? transferred_chunks : null,
    bytes_transferred !== undefined ? bytes_transferred : null,
    newStatus,
    newStatus,
    req.params.id
  );

  const updated = formatSession(db.prepare('SELECT * FROM nerodrop_sessions WHERE id = ?').get(req.params.id));
  return res.status(200).json({ success: true, session: updated });
}

router.put('/transfers/:id/progress', updateProgressHandler);
router.put('/session/:id/progress', updateProgressHandler);

// 5. Cancel Transfer Session
function cancelTransferHandler(req, res) {
  const db = getDatabase();
  const session = db.prepare('SELECT * FROM nerodrop_sessions WHERE id = ?').get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Transfer session not found' });
  }
  if (req.user.role !== 'super-admin' && session.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access forbidden' });
  }

  db.prepare("UPDATE nerodrop_sessions SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(
    req.params.id
  );

  logAuditEvent({
    eventType: 'NERODROP_SESSION_CANCEL',
    severity: 'info',
    actorUserId: req.user.id,
    actorUsername: req.user.username,
    targetId: req.params.id,
    targetType: 'nerodrop',
    message: `NeroDrop transfer session ${req.params.id} cancelled`,
    ipAddress: req.ip
  });

  return res.status(200).json({ success: true, session_id: req.params.id, status: 'cancelled' });
}

router.post('/transfers/:id/cancel', cancelTransferHandler);
router.post('/session/:id/cancel', cancelTransferHandler);

module.exports = router;
