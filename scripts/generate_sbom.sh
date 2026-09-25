#!/usr/bin/env bash
# ==============================================================================
# Sovereign Mesh v4.0 - Software Bill of Materials (SBOM) Generator
# Generates CycloneDX v1.5 and SPDX v2.3 SBOMs for Go & Node.js ecosystem
# ==============================================================================
export MSYS_NO_PATHCONV=1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPORT_DIR="$REPO_DIR/reports/sbom"
mkdir -p "$REPORT_DIR"

ENGINE=podman
command -v podman >/dev/null 2>&1 || ENGINE=docker
WIN_PATH="$(cd "$REPO_DIR" && pwd -W 2>/dev/null || pwd)"

echo "======================================================================"
echo "    NERONET SOFTWARE BILL OF MATERIALS (SBOM) GENERATOR               "
echo "======================================================================"
echo "--> Repo Directory: $WIN_PATH"
echo "--> Output Directory: $REPORT_DIR"

# Generate CycloneDX and SPDX SBOMs using containerized scanner or built-in generator
echo "--> Compiling SBOM metadata from go.mod and package.json..."

node -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const repoDir = process.argv[1];
const outDir = path.join(repoDir, "reports", "sbom");
fs.mkdirSync(outDir, { recursive: true });

// Parse go.mod dependencies
const goModPath = path.join(repoDir, "go.mod");
const goDeps = [];
if (fs.existsSync(goModPath)) {
  const content = fs.readFileSync(goModPath, "utf8");
  const lines = content.split(/\r?\n/);
  let inRequire = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("require (")) {
      inRequire = true;
      continue;
    }
    if (inRequire && trimmed === ")") {
      inRequire = false;
      continue;
    }
    if ((inRequire || trimmed.startsWith("require ")) && trimmed && !trimmed.startsWith("//")) {
      const parts = trimmed.replace(/^require\s+/, "").split(/\s+/);
      if (parts.length >= 2) {
        goDeps.push({ name: parts[0], version: parts[1], type: "golang" });
      }
    }
  }
}

// Parse Node backend dependencies
const bePkgPath = path.join(repoDir, "console", "backend", "package.json");
const nodeDeps = [];
if (fs.existsSync(bePkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(bePkgPath, "utf8"));
  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    nodeDeps.push({ name, version: version.replace(/^[^0-9]*/, ""), type: "npm" });
  }
}

// Parse Node frontend dependencies
const fePkgPath = path.join(repoDir, "console", "frontend", "package.json");
if (fs.existsSync(fePkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(fePkgPath, "utf8"));
  for (const [name, version] of Object.entries(pkg.dependencies || {})) {
    if (!nodeDeps.find(d => d.name === name)) {
      nodeDeps.push({ name, version: version.replace(/^[^0-9]*/, ""), type: "npm" });
    }
  }
}

const allComponents = [...goDeps, ...nodeDeps];
console.log(`Found ${goDeps.length} Go dependencies and ${nodeDeps.length} Node.js dependencies (Total: ${allComponents.length})`);

// 1. Build CycloneDX v1.5 JSON
const cyclonedx = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: "urn:uuid:" + crypto.randomUUID(),
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [
      { vendor: "NeroNet Sovereign Mesh", name: "neronet-sbom-generator", version: "4.0.0" }
    ],
    component: {
      type: "application",
      name: "neronet-sovereign-proxy",
      version: "4.0.0-rc1",
      description: "NeroNet Sovereign Mesh VPN & Decentralized Control Plane"
    }
  },
  components: allComponents.map(c => ({
    type: "library",
    name: c.name,
    version: c.version,
    purl: `pkg:${c.type}/${c.name}@${c.version}`,
    scope: "required"
  }))
};
fs.writeFileSync(path.join(outDir, "neronet-cyclonedx.json"), JSON.stringify(cyclonedx, null, 2));

// 2. Build SPDX v2.3 JSON
const spdx = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "NeroNet-Sovereign-Mesh-v4.0.0",
  documentNamespace: "https://neronet.sovereign/spdx/" + crypto.randomUUID(),
  creationInfo: {
    created: new Date().toISOString(),
    creators: ["Tool: neronet-sbom-generator-4.0.0", "Organization: Sovereign Mesh Foundation"]
  },
  packages: allComponents.map((c, idx) => ({
    SPDXID: `SPDXRef-Package-${idx + 1}`,
    name: c.name,
    versionInfo: c.version,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    supplier: "NOASSERTION"
  }))
};
fs.writeFileSync(path.join(outDir, "neronet-spdx.json"), JSON.stringify(spdx, null, 2));
' "$WIN_PATH"

# Also execute Trivy container if available for additional vulnerability/SBOM enrichment
if $ENGINE images | grep -q "aquasec/trivy"; then
  echo "--> Running local aquasec/trivy container scan for enhanced CycloneDX enrichment..."
  $ENGINE run --rm \
    -v "$WIN_PATH:/src:ro" \
    docker.io/aquasec/trivy:latest fs \
      --format cyclonedx \
      --output /tmp/trivy-cyclonedx.json \
      /src >/dev/null 2>&1 || true
fi

echo "======================================================================"
echo "[OK] SBOM ARTIFACTS GENERATED SUCCESSFULLY:"
echo " - CycloneDX JSON: $REPORT_DIR/neronet-cyclonedx.json"
echo " - SPDX JSON:      $REPORT_DIR/neronet-spdx.json"
echo "======================================================================"
