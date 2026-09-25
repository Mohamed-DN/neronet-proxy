/**
 * InternalCAService — WP-304 TLS Everywhere + Internal CA
 *
 * One self-signed ECDSA P-256 root CA per deployment, stored in PostgreSQL.
 * Nodes pin the CA fingerprint at enrollment and refuse to reconnect if it
 * changes (TOFU with explicit re-pin workflow).
 *
 * This module uses Node's built-in `crypto` module only — zero external npm dependencies,
 * zero subprocesses, pure JavaScript ASN.1 DER structure encoding with ECDSA P-256 signatures.
 *
 * Features:
 *   - Idempotent Root CA provisioning (EC prime256v1, SHA-256)
 *   - Leaf certificate issuance signed by deployment Root CA
 *   - Node certificate fingerprint pinning (TOFU with fail-closed rejection on mismatch)
 *   - Certificate revocation
 */

'use strict';

const crypto = require('node:crypto');
const { getPgPool } = require('../db/index');
const logger = require('../utils/logger');

// Validity periods
const CA_VALIDITY_YEARS = 10;
const NODE_CERT_VALIDITY_DAYS = 90;

// ASN.1 DER Encoding Helpers
function derLength(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  let l = len;
  while (l > 0) {
    bytes.unshift(l & 0xff);
    l >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derSequence(contents) {
  const buf = Buffer.isBuffer(contents) ? contents : Buffer.concat(contents);
  return Buffer.concat([Buffer.from([0x30]), derLength(buf.length), buf]);
}

function derInteger(numOrBuf) {
  let buf = Buffer.isBuffer(numOrBuf) ? numOrBuf : Buffer.from([numOrBuf]);
  if (buf[0] & 0x80) {
    buf = Buffer.concat([Buffer.from([0x00]), buf]);
  }
  return Buffer.concat([Buffer.from([0x02]), derLength(buf.length), buf]);
}

function derBitString(buf) {
  return Buffer.concat([Buffer.from([0x03]), derLength(buf.length + 1), Buffer.from([0x00]), buf]);
}

function derOctetString(buf) {
  return Buffer.concat([Buffer.from([0x04]), derLength(buf.length), buf]);
}

function derOid(oidStr) {
  const parts = oidStr.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    const sub = [val & 0x7f];
    while ((val >>= 7) > 0) {
      sub.unshift(0x80 | (val & 0x7f));
    }
    bytes.push(...sub);
  }
  const b = Buffer.from(bytes);
  return Buffer.concat([Buffer.from([0x06]), derLength(b.length), b]);
}

function derUtf8String(str) {
  const buf = Buffer.from(str, 'utf8');
  return Buffer.concat([Buffer.from([0x0c]), derLength(buf.length), buf]);
}

function derUtcTime(date) {
  const pad = (n) => (n < 10 ? '0' : '') + n;
  const str =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  const buf = Buffer.from(str, 'ascii');
  return Buffer.concat([Buffer.from([0x17]), derLength(buf.length), buf]);
}

// OIDs
const OID_ECDSA_SHA256 = derOid('1.2.840.10045.4.3.2');
const OID_CN = derOid('2.5.4.3');
const OID_O = derOid('2.5.4.10');
const OID_BASIC_CONSTRAINTS = derOid('2.5.29.19');
const algId = derSequence([OID_ECDSA_SHA256]);

function derName(cn, org) {
  const parts = [];
  if (org) {
    const rdnOrg = Buffer.concat([
      Buffer.from([0x31]),
      derLength(derSequence([OID_O, derUtf8String(org)]).length),
      derSequence([OID_O, derUtf8String(org)])
    ]);
    parts.push(rdnOrg);
  }
  if (cn) {
    const rdnCn = Buffer.concat([
      Buffer.from([0x31]),
      derLength(derSequence([OID_CN, derUtf8String(cn)]).length),
      derSequence([OID_CN, derUtf8String(cn)])
    ]);
    parts.push(rdnCn);
  }
  return derSequence(parts);
}

/**
 * Generates an ECDSA P-256 self-signed root CA certificate.
 */
function createSelfSignedRootCA({
  commonName = 'NeroNet Internal CA',
  organization = 'NeroNet',
  validityYears = CA_VALIDITY_YEARS
} = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  const serial = crypto.randomBytes(8);
  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + validityYears);

  const validity = derSequence([derUtcTime(notBefore), derUtcTime(notAfter)]);
  const subjectName = derName(commonName, organization);
  const v3Tag = Buffer.concat([Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02])]);

  // BasicConstraints CA:TRUE, critical: TRUE
  const bcValue = derSequence([Buffer.from([0x01, 0x01, 0xff])]);
  const bcExt = derSequence([OID_BASIC_CONSTRAINTS, Buffer.from([0x01, 0x01, 0xff]), derOctetString(bcValue)]);

  const extensionsSeq = derSequence([bcExt]);
  const extensionsTag = Buffer.concat([Buffer.from([0xa3]), derLength(extensionsSeq.length), extensionsSeq]);

  const tbs = derSequence([
    v3Tag,
    derInteger(serial),
    algId,
    subjectName, // issuer
    validity,
    subjectName, // subject
    spkiDer,
    extensionsTag
  ]);

  const sig = crypto.sign('SHA256', tbs, privateKey);
  const certDer = derSequence([tbs, algId, derBitString(sig)]);
  const certPem = `-----BEGIN CERTIFICATE-----\n${certDer
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n')}\n-----END CERTIFICATE-----\n`;
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const fingerprintSha256 = crypto.createHash('sha256').update(certDer).digest('hex');

  return { certPem, privateKeyPem, fingerprintSha256, notBefore, notAfter };
}

/**
 * Issues an ECDSA P-256 leaf certificate signed by the Root CA.
 */
function createNodeLeafCertificate({
  caCertPem,
  caPrivateKeyPem,
  commonName,
  validityDays = NODE_CERT_VALIDITY_DAYS
} = {}) {
  const caCert = new crypto.X509Certificate(caCertPem);
  const caKey = crypto.createPrivateKey(caPrivateKeyPem);

  const { publicKey: leafPub, privateKey: leafPriv } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiDer = leafPub.export({ type: 'spki', format: 'der' });

  const serial = crypto.randomBytes(8);
  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setDate(notAfter.getDate() + validityDays);

  const validity = derSequence([derUtcTime(notBefore), derUtcTime(notAfter)]);
  const caOrg = caCert.subject.match(/O=([^,\n]+)/)?.[1] || 'NeroNet';
  const caCn = caCert.subject.match(/CN=([^,\n]+)/)?.[1] || 'NeroNet Internal CA';
  const issuerDer = derName(caCn, caOrg);
  const subjectDer = derName(commonName, caOrg);

  const v3Tag = Buffer.concat([Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02])]);

  // BasicConstraints CA:FALSE
  const bcValue = derSequence([Buffer.from([0x01, 0x01, 0x00])]);
  const bcExt = derSequence([OID_BASIC_CONSTRAINTS, derOctetString(bcValue)]);

  const extensionsSeq = derSequence([bcExt]);
  const extensionsTag = Buffer.concat([Buffer.from([0xa3]), derLength(extensionsSeq.length), extensionsSeq]);

  const tbs = derSequence([v3Tag, derInteger(serial), algId, issuerDer, validity, subjectDer, spkiDer, extensionsTag]);

  const sig = crypto.sign('SHA256', tbs, caKey);
  const certDer = derSequence([tbs, algId, derBitString(sig)]);
  const certPem = `-----BEGIN CERTIFICATE-----\n${certDer
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n')}\n-----END CERTIFICATE-----\n`;
  const privateKeyPem = leafPriv.export({ type: 'pkcs8', format: 'pem' });
  const fingerprintSha256 = crypto.createHash('sha256').update(certDer).digest('hex');

  return { certPem, privateKeyPem, fingerprintSha256, notBefore, notAfter };
}

/**
 * Provision (or retrieve) the deployment root CA.
 * Idempotent: if a CA already exists in the database it is returned as-is.
 */
async function provisionRootCA({ commonName = 'NeroNet Internal CA', organization = 'NeroNet' } = {}) {
  const pool = getPgPool();

  const existing = await pool.query('SELECT * FROM internal_ca WHERE id = $1', ['root']);
  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const ca = createSelfSignedRootCA({ commonName, organization });

  const result = await pool.query(
    `INSERT INTO internal_ca
       (id, common_name, organization, cert_pem, private_key_pem, fingerprint_sha256, not_before, not_after)
     VALUES
       ('root', $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [commonName, organization, ca.certPem, ca.privateKeyPem, ca.fingerprintSha256, ca.notBefore, ca.notAfter]
  );

  logger.info(`[InternalCA] Root CA provisioned with fingerprint: ${ca.fingerprintSha256}`);
  return result.rows[0];
}

/**
 * Returns the deployment root CA record from the database.
 */
async function getRootCA() {
  const pool = getPgPool();
  const res = await pool.query('SELECT * FROM internal_ca WHERE id = $1', ['root']);
  if (res.rows.length === 0) {
    return provisionRootCA();
  }
  return res.rows[0];
}

/**
 * Returns the root CA certificate in PEM format.
 */
async function getCACertPem() {
  const ca = await getRootCA();
  return ca.cert_pem;
}

/**
 * Returns the SHA-256 fingerprint of the current root CA.
 */
async function getCAFingerprint() {
  const ca = await getRootCA();
  return ca.fingerprint_sha256;
}

/**
 * Issues a leaf certificate for a specific node and saves it in node_certificates.
 */
async function issueNodeCertificate(
  nodeId,
  { commonName = `node-${nodeId}`, validityDays = NODE_CERT_VALIDITY_DAYS } = {}
) {
  const pool = getPgPool();
  const ca = await getRootCA();

  const leaf = createNodeLeafCertificate({
    caCertPem: ca.cert_pem,
    caPrivateKeyPem: ca.private_key_pem,
    commonName,
    validityDays
  });

  const res = await pool.query(
    `INSERT INTO node_certificates
       (node_id, cert_pem, fingerprint_sha256, not_before, not_after)
     VALUES
       ($1, $2, $3, $4, $5)
     RETURNING *`,
    [nodeId, leaf.certPem, leaf.fingerprintSha256, leaf.notBefore, leaf.notAfter]
  );

  return {
    ...res.rows[0],
    private_key_pem: leaf.privateKeyPem
  };
}

/**
 * Pin the current CA fingerprint to a node record.
 */
async function pinCAFingerprintToNode(nodeId, fingerprint) {
  const pool = getPgPool();
  const fp = fingerprint || (await getCAFingerprint());

  await pool.query('UPDATE nodes SET pinned_ca_fingerprint = $1 WHERE id = $2', [fp, nodeId]);

  logger.info(`[InternalCA] Node ${nodeId} pinned to CA fingerprint: ${fp}`);
  return fp;
}

/**
 * Verifies that the node's stored pinned fingerprint matches the current CA fingerprint.
 * Implements TOFU: if pinned_ca_fingerprint is NULL, auto-pins on first connection.
 * If pinned_ca_fingerprint does not match, returns false (fail-closed TLS rejection).
 */
async function verifyNodePin(nodeId) {
  const pool = getPgPool();
  const currentFp = await getCAFingerprint();

  const res = await pool.query('SELECT pinned_ca_fingerprint FROM nodes WHERE id = $1', [nodeId]);

  if (res.rows.length === 0) {
    return false;
  }

  const pinnedFp = res.rows[0].pinned_ca_fingerprint;

  // TOFU: unpinned node auto-pins on first check
  if (!pinnedFp) {
    await pinCAFingerprintToNode(nodeId, currentFp);
    return true;
  }

  // Constant-time comparison to prevent timing attacks
  const a = Buffer.from(pinnedFp, 'utf8');
  const b = Buffer.from(currentFp, 'utf8');

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

/**
 * Revokes a node certificate.
 */
async function revokeNodeCertificate(certId, reason = 'key_compromise') {
  const pool = getPgPool();
  const res = await pool.query(
    `UPDATE node_certificates
     SET revoked = true, revoked_at = now(), revoke_reason = $1
     WHERE id = $2
     RETURNING *`,
    [reason, certId]
  );
  return res.rows[0];
}

module.exports = {
  provisionRootCA,
  getRootCA,
  getCACertPem,
  getCAFingerprint,
  issueNodeCertificate,
  pinCAFingerprintToNode,
  verifyNodePin,
  revokeNodeCertificate,
  createSelfSignedRootCA,
  createNodeLeafCertificate
};
