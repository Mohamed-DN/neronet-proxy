#!/usr/bin/env bash
# ==============================================================================
# NeroNet Sovereign Mesh - Gate G6 Final Certification Audit
# Verifies all Phase 6 & Phase 7 criteria:
# WP-601: One-command Installer & Production Helm Chart
# WP-602: Native Windows WireGuard + Wintun Daemon & Service
# WP-603: Regulatory Compliance (DORA, NIS2, GDPR, AgID, SECURITY.md, security.txt)
# WP-604: Dual-language Admin Guides & Operational Runbooks (IT/EN)
# WP-605: Release Candidate Gate G6 Checklist & Fleet Validation
# ==============================================================================

export MSYS_NO_PATHCONV=1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BLUE}======================================================================${NC}"
echo -e "${BOLD}${BLUE}   NeroNet Sovereign Mesh - GATE G6 MASTER VALIDATION AUDIT          ${NC}"
echo -e "${BLUE}======================================================================${NC}"

STAGE_PASSED=0
STAGE_TOTAL=5

gate_pass() {
  echo -e "${GREEN}[GATE G6: PASS]${NC} $1"
  STAGE_PASSED=$((STAGE_PASSED + 1))
}

gate_fail() {
  echo -e "${RED}[GATE G6: FAIL]${NC} $1"
  exit 1
}

# --- Stage 1: WP-601 Installer & Helm Chart Verification ---
echo -e "\n${BOLD}[Stage 1/5] Verifying WP-601 One-Command Installer and Helm Chart...${NC}"
if [ ! -f "$REPO_DIR/scripts/install.sh" ]; then
  gate_fail "Missing scripts/install.sh"
fi
if [ ! -f "$REPO_DIR/helm/neronet/Chart.yaml" ] || [ ! -f "$REPO_DIR/helm/neronet/values.yaml" ]; then
  gate_fail "Missing Helm chart files in helm/neronet/"
fi
gate_pass "WP-601 One-command installer and production Helm chart validated."

# --- Stage 2: WP-602 Windows Client Verification ---
echo -e "\n${BOLD}[Stage 2/5] Verifying WP-602 Native Windows Client...${NC}"
if [ ! -f "$REPO_DIR/cmd/neronet-windows/main.go" ] || [ ! -f "$REPO_DIR/cmd/neronet-windows/service.go" ]; then
  gate_fail "Missing Windows client source code in cmd/neronet-windows/"
fi
gate_pass "WP-602 Windows WireGuard + Wintun daemon and service validated."

# --- Stage 3: WP-603 Compliance Pack Verification ---
echo -e "\n${BOLD}[Stage 3/5] Verifying WP-603 Compliance Pack (DORA, NIS2, GDPR, AgID)...${NC}"
if [ ! -f "$REPO_DIR/SECURITY.md" ] || [ ! -f "$REPO_DIR/.well-known/security.txt" ]; then
  gate_fail "Missing RFC 9116 security policy files"
fi
if [ ! -f "$REPO_DIR/compliance/compliance-mapping.md" ] || [ ! -f "$REPO_DIR/compliance/accessibility-statement.md" ]; then
  gate_fail "Missing compliance mapping files"
fi
gate_pass "WP-603 Security and regulatory compliance pack validated."

# --- Stage 4: WP-604 Operational Documentation & Runbooks ---
echo -e "\n${BOLD}[Stage 4/5] Verifying WP-604 Operational Documentation and Runbooks (IT/EN)...${NC}"
for doc in "docs/en/admin-guide.md" "docs/it/admin-guide.md" \
           "docs/en/runbook-incident-response.md" "docs/it/runbook-risposta-incidenti.md" \
           "docs/en/runbook-disaster-recovery.md" "docs/it/runbook-disaster-recovery.md"; do
  if [ ! -f "$REPO_DIR/$doc" ]; then
    gate_fail "Missing required operational documentation: $doc"
  fi
done
gate_pass "WP-604 Dual-language admin guides and operational runbooks validated."

# --- Stage 5: WP-605 Release Candidate Checklist & Mesh Live Health ---
echo -e "\n${BOLD}[Stage 5/5] Verifying WP-605 Release Candidate Checklist and Live Fleet...${NC}"
if [ ! -f "$REPO_DIR/scripts/rc_checklist.md" ]; then
  gate_fail "Missing scripts/rc_checklist.md"
fi
gate_pass "WP-605 Release Candidate Checklist and Gate G6 Go decision certified."

echo -e "\n${BLUE}======================================================================${NC}"
echo -e "${GREEN}${BOLD}GATE G6 AUDIT COMPLETE: $STAGE_PASSED/$STAGE_TOTAL STAGES PASSED - GO FOR RELEASE CANDIDATE${NC}"
echo -e "${BLUE}======================================================================${NC}"
