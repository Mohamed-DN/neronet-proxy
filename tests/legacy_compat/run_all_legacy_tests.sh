#!/usr/bin/env bash
# ==============================================================================
# Sovereign Proxy v4.0 - Master Milestone 1 Verification Test Suite Runner
# Location: tests/legacy_compat/run_all_legacy_tests.sh
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BLUE}${BOLD}"
echo "╔═══════════════════════════════════════════════════════════════════════╗"
echo "║ Sovereign Proxy v4.0 - Milestone 1 Legacy & Security Test Suite Runner║"
echo "╚═══════════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

SUITES_PASSED=0
SUITES_FAILED=0

run_suite() {
    local suite_name="$1"
    local suite_cmd="$2"

    echo -e "\n${YELLOW}${BOLD}>>> Running Suite: ${suite_name}...${NC}"
    if eval "$suite_cmd"; then
        echo -e "${GREEN}${BOLD}[✓] Suite '${suite_name}' PASSED${NC}"
        SUITES_PASSED=$((SUITES_PASSED + 1))
    else
        echo -e "${RED}${BOLD}[✗] Suite '${suite_name}' FAILED${NC}"
        SUITES_FAILED=$((SUITES_FAILED + 1))
    fi
}

# 1. SQL Injection Attack Suite
run_suite "SQL Injection Adversarial Defense" "bash '${SCRIPT_DIR}/test_sqli_protection.sh'"

# 2. Security Daemon Logic & Rate Limiting Test
run_suite "Security Daemon Logic & Token Bucket" "python3 -c \"
import sys
sys.path.insert(0, '${PROJECT_ROOT}/cmd/sovereign-security-daemon')
import daemon, unittest

class TestSecurityDaemonLogic(unittest.TestCase):
    def test_whitelist(self):
        wm = daemon.WhitelistManager(daemon.DEFAULT_WHITELIST)
        self.assertTrue(wm.is_whitelisted('127.0.0.1'))
        self.assertTrue(wm.is_whitelisted('10.200.1.1'))
        self.assertTrue(wm.is_whitelisted('192.168.1.50'))
        self.assertTrue(wm.is_whitelisted('1.1.1.1'))
        self.assertTrue(wm.is_whitelisted('8.8.8.8'))
        self.assertTrue(wm.is_whitelisted('9.9.9.9'))
        self.assertFalse(wm.is_whitelisted('203.0.113.15'))

    def test_token_bucket(self):
        limiter = daemon.DualTokenBucketLimiter(ip_cap=5, ip_refill=1.0)
        test_ip = '203.0.113.88'
        for _ in range(5):
            self.assertTrue(limiter.allow(test_ip))
        self.assertFalse(limiter.allow(test_ip))

    def test_threat_scorer(self):
        scorer = daemon.ThreatScorer(ban_threshold=100, half_life_seconds=3600.0)
        score1, ban1 = scorer.record_threat('198.51.100.10', 35.0)
        self.assertEqual(score1, 35.0)
        self.assertFalse(ban1)
        score2, ban2 = scorer.record_threat('198.51.100.10', 70.0)
        self.assertTrue(score2 >= 100.0)
        self.assertTrue(ban2)

suite = unittest.TestLoader().loadTestsFromTestCase(TestSecurityDaemonLogic)
result = unittest.TextTestRunner(verbosity=2).run(suite)
if not result.wasSuccessful():
    sys.exit(1)
\""

echo -e "\n${BLUE}${BOLD}=======================================================================${NC}"
echo -e "Master Test Summary: ${GREEN}${SUITES_PASSED} Suites Passed${NC}, ${RED}${SUITES_FAILED} Suites Failed${NC} (Total: 2 Suites)"
echo -e "${BLUE}${BOLD}=======================================================================${NC}\n"

if [[ "$SUITES_FAILED" -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}[✓] ALL MILESTONE 1 VERIFICATION TESTS PASSED SUCCESSFULLY!${NC}\n"
    exit 0
else
    echo -e "${RED}${BOLD}[✗] ONE OR MORE TEST SUITES FAILED.${NC}\n"
    exit 1
fi
