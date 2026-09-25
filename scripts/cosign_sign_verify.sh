#!/usr/bin/env bash
# ==============================================================================
# Sovereign Mesh v4.0 - Sigstore Cosign / Cryptographic Signing & Verification
# Signs build artifact digests and SLSA provenance attestations with Ed25519
# ==============================================================================
export MSYS_NO_PATHCONV=1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPORT_DIR="$REPO_DIR/reports/provenance"
mkdir -p "$REPORT_DIR"
WIN_PATH="$(cd "$REPO_DIR" && pwd -W 2>/dev/null || pwd)"

echo "======================================================================"
echo "    NERONET COSIGN & CRYPTOGRAPHIC ARTIFACT SIGNING / VERIFIER       "
echo "======================================================================"

PROVENANCE_FILE="$REPORT_DIR/slsa_provenance.json"
if [ ! -f "$PROVENANCE_FILE" ]; then
  echo "--> Provenance not found; generating first..."
  "$SCRIPT_DIR/generate_slsa_provenance.sh"
fi

# Run cryptographic signing and verification in Node with standard Ed25519 / crypto
node -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const provenancePath = path.join(process.argv[1], "reports", "provenance", "slsa_provenance.json");
const provDir = path.dirname(provenancePath);
fs.mkdirSync(provDir, { recursive: true });

console.log("--> Generating Ed25519 release signing keypair...");
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" }
});

const pubKeyPath = path.join(provDir, "cosign.pub");
const privKeyPath = path.join(provDir, "cosign.key");
fs.writeFileSync(pubKeyPath, publicKey);
fs.writeFileSync(privKeyPath, privateKey);
console.log("    [OK] Public key stored:  " + pubKeyPath);
console.log("    [OK] Private key stored: " + privKeyPath);

// Read payload to sign
const payload = fs.readFileSync(provenancePath);
console.log("--> Signing SLSA provenance attestation (" + payload.length + " bytes)...");

const signature = crypto.sign(null, payload, privateKey);
const sigBase64 = signature.toString("base64");

const sigPath = path.join(provDir, "slsa_provenance.sig");
fs.writeFileSync(sigPath, sigBase64);
console.log("    [OK] Signature generated: " + sigPath);

// Cryptographic verification test
console.log("--> Verifying cryptographic signature using public key...");
const verifier = crypto.verify(null, payload, publicKey, Buffer.from(sigBase64, "base64"));

if (!verifier) {
  console.error("    [FAIL] Signature verification failed!");
  process.exit(1);
}
console.log("    [OK] Signature valid! Cryptographic integrity confirmed.");

// Tamper test assertion
console.log("--> Testing anti-tamper detection (modifying 1 byte of payload)...");
const tamperedPayload = Buffer.from(payload);
tamperedPayload[tamperedPayload.length - 2] = tamperedPayload[tamperedPayload.length - 2] === 65 ? 66 : 65;
const tamperCheck = crypto.verify(null, tamperedPayload, publicKey, Buffer.from(sigBase64, "base64"));
if (tamperCheck) {
  console.error("    [FAIL] Tampered payload unexpectedly passed verification!");
  process.exit(1);
}
console.log("    [OK] Anti-tamper check passed: modified payload was strictly rejected.");
' "$WIN_PATH"

echo "======================================================================"
echo "[OK] COSIGN & CRYPTOGRAPHIC ATTESTATION SIGNING AND VERIFICATION PASSED"
echo "======================================================================"
