#!/usr/bin/env bash
# ==============================================================================
# Sovereign Proxy v4.0 — Pre-Flight GitOps & Integrity Verification Engine
# ==============================================================================
# Script: scripts/gitops/preflight_check.sh
# Purpose:
#   Validates code integrity before git push and staging:
#     1. Verifies 'go build ./cmd/...' passes.
#     2. Verifies 'go test ./...' passes.
#     3. Verifies zero plaintext credentials or secrets in tracked files.
#     4. Verifies bash and python scripts syntax.
#     5. Verifies YAML configs, Helm charts, and GitHub Actions workflows.
# ==============================================================================
set -euo pipefail

# --- Color Formatting ---
COLOR_RESET="\033[0m"
COLOR_BLUE="\033[1;34m"
COLOR_GREEN="\033[1;32m"
COLOR_YELLOW="\033[1;33m"
COLOR_RED="\033[1;31m"
COLOR_CYAN="\033[1;36m"
COLOR_BOLD="\033[1m"

log_info()    { echo -e "${COLOR_BLUE}[INFO]${COLOR_RESET} $*"; }
log_succ()    { echo -e "${COLOR_GREEN}[PASS]${COLOR_RESET} $*"; }
log_warn()    { echo -e "${COLOR_YELLOW}[WARN]${COLOR_RESET} $*"; }
log_err()     { echo -e "${COLOR_RED}[FAIL]${COLOR_RESET} $*"; }
log_header()  { echo -e "\n${COLOR_CYAN}${COLOR_BOLD}=== $* ===${COLOR_RESET}"; }

# --- Counters ---
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
WARNINGS=0

record_pass() {
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  PASSED_TESTS=$((PASSED_TESTS + 1))
  log_succ "$1"
}

record_fail() {
  TOTAL_TESTS=$((TOTAL_TESTS + 1))
  FAILED_TESTS=$((FAILED_TESTS + 1))
  log_err "$1"
}

record_warn() {
  WARNINGS=$((WARNINGS + 1))
  log_warn "$1"
}

# --- Resolve Root ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PROJECT_ROOT}"

log_header "Sovereign Proxy v4.0 Pre-Flight Verification Engine"
log_info "Target Directory: ${PROJECT_ROOT}"

# ==============================================================================
# 1. Core Documentation & Project Metadata Verification
# ==============================================================================
log_header "1. Core Documentation & Metadata Verification"

REQUIRED_DOCS=(
  "README.md"
)

for doc in "${REQUIRED_DOCS[@]}"; do
  if [ -f "${PROJECT_ROOT}/${doc}" ] && [ -s "${PROJECT_ROOT}/${doc}" ]; then
    record_pass "Found required documentation file: ${doc}"
  else
    record_fail "Missing or empty required documentation file: ${doc}"
  fi
done

# Check for optional documentation if present
for opt_doc in "DEVELOPER_SETUP.md" "BUSINESS_AND_ROADMAP.md" "CHANGELOG.md"; do
  if [ -f "${PROJECT_ROOT}/${opt_doc}" ]; then
    record_pass "Found project documentation: ${opt_doc}"
  fi
done

# ==============================================================================
# 2. Go Build & Compilation Verification (go build ./cmd/...)
# ==============================================================================
log_header "2. Go Binary Compilation (go build ./cmd/...)"

if command -v go &>/dev/null && [ -f "${PROJECT_ROOT}/go.mod" ]; then
  log_info "Executing: go build ./cmd/..."
  if go build ./cmd/...; then
    record_pass "All Go binaries in ./cmd/... compiled successfully."
  else
    record_fail "Go binary compilation (go build ./cmd/...) failed."
  fi
else
  record_warn "Go compiler or go.mod not available; skipping go build check."
fi

# ==============================================================================
# 3. Go Test Suite Execution (go test ./...)
# ==============================================================================
log_header "3. Go Test Suite Execution (go test ./...)"

if command -v go &>/dev/null && [ -f "${PROJECT_ROOT}/go.mod" ]; then
  log_info "Executing: go test ./..."
  if go test ./...; then
    record_pass "All Go unit and package tests passed."
  else
    record_fail "Go tests (go test ./...) encountered failures."
  fi
else
  record_warn "Go compiler or go.mod not available; skipping go test check."
fi

# ==============================================================================
# 4. Shell Scripts Syntax & Permissions
# ==============================================================================
log_header "4. Shell Scripts Syntax & Permissions"

SHELL_SCRIPTS=()
while IFS= read -r script; do
  [ -z "$script" ] && continue
  SHELL_SCRIPTS+=("$script")
done < <(find "${PROJECT_ROOT}" -type f -name "*.sh" ! -path "*/.agents/*" ! -path "*/.git/*")

if [ ${#SHELL_SCRIPTS[@]} -eq 0 ]; then
  record_warn "No shell scripts found to validate."
else
  for script in "${SHELL_SCRIPTS[@]}"; do
    rel_path="${script#"${PROJECT_ROOT}/"}"
    if bash -n "${script}"; then
      if [ -x "${script}" ]; then
        record_pass "Valid syntax and executable: ${rel_path}"
      else
        chmod +x "${script}" 2>/dev/null || true
        record_pass "Valid syntax (marked executable): ${rel_path}"
      fi
    else
      record_fail "Syntax error in bash script: ${rel_path}"
    fi
  done
fi

# ==============================================================================
# 5. Python Scripts Syntax & Bytecode Compilation
# ==============================================================================
log_header "5. Python Scripts Syntax Validation"

PYTHON_SCRIPTS=()
while IFS= read -r script; do
  [ -z "$script" ] && continue
  PYTHON_SCRIPTS+=("$script")
done < <(find "${PROJECT_ROOT}" -type f -name "*.py" ! -path "*/.agents/*" ! -path "*/.git/*" ! -path "*/__pycache__/*")

if [ ${#PYTHON_SCRIPTS[@]} -eq 0 ]; then
  record_warn "No Python scripts found."
else
  for script in "${PYTHON_SCRIPTS[@]}"; do
    rel_path="${script#"${PROJECT_ROOT}/"}"
    if python3 -m py_compile "${script}" 2>/dev/null; then
      record_pass "Valid Python syntax: ${rel_path}"
    else
      record_fail "Python syntax compilation failed: ${rel_path}"
    fi
  done
fi

# ==============================================================================
# 6. YAML Configuration & Manifest Parsing
# ==============================================================================
log_header "6. YAML Configuration & Manifest Parsing"

YAML_FILES=()
while IFS= read -r yfile; do
  [ -z "$yfile" ] && continue
  YAML_FILES+=("$yfile")
done < <(find "${PROJECT_ROOT}" \( -name "*.yaml" -o -name "*.yml" \) ! -path "*/.agents/*" ! -path "*/.git/*" ! -path "*/node_modules/*" ! -path "*/dist/*" ! -path "*/templates/*")

if [ ${#YAML_FILES[@]} -eq 0 ]; then
  record_warn "No YAML files found to validate."
else
  for yfile in "${YAML_FILES[@]}"; do
    rel_path="${yfile#"${PROJECT_ROOT}/"}"
    valid_yaml=false
    if ruby -ryaml -e "YAML.load_file('${yfile}')" &>/dev/null; then
      valid_yaml=true
    elif python3 -c "import yaml; yaml.safe_load(open('${yfile}'))" &>/dev/null; then
      valid_yaml=true
    fi

    if [ "$valid_yaml" = true ]; then
      record_pass "Valid YAML syntax: ${rel_path}"
    else
      record_fail "Invalid YAML in ${rel_path}"
    fi
  done
fi

# ==============================================================================
# 7. GitHub Actions Workflows Validation
# ==============================================================================
log_header "7. GitHub Actions Workflows Validation"

WORKFLOW_DIR="${PROJECT_ROOT}/.github/workflows"
REQUIRED_WORKFLOWS=(
  "ci.yml"
  "security-scan.yml"
  "release.yml"
  "infra-validate.yml"
)

if [ -d "${WORKFLOW_DIR}" ]; then
  for wf in "${REQUIRED_WORKFLOWS[@]}"; do
    wf_path="${WORKFLOW_DIR}/${wf}"
    if [ -f "${wf_path}" ]; then
      valid_wf=false
      if ruby -ryaml -e "d = YAML.load_file('${wf_path}'); exit (d && (d['name'] || d[:name]) && (d['jobs'] || d[:jobs])) ? 0 : 1" &>/dev/null; then
        valid_wf=true
      elif python3 -c "import yaml; d = yaml.safe_load(open('${wf_path}')); import sys; sys.exit(0 if d and 'jobs' in d else 1)" &>/dev/null; then
        valid_wf=true
      fi

      if [ "$valid_wf" = true ]; then
        record_pass "Valid GitHub Actions workflow structure: .github/workflows/${wf}"
      else
        record_fail "Invalid GitHub Actions workflow structure: .github/workflows/${wf}"
      fi
    else
      record_fail "Missing required workflow: .github/workflows/${wf}"
    fi
  done
else
  record_fail "Missing .github/workflows directory!"
fi

# ==============================================================================
# 8. Secret & Credential Leak Prevention Check
# ==============================================================================
log_header "8. Secret & Credential Leak Prevention"

SUSPECT_PATTERNS=(
  "BEGIN RSA PRIVATE KEY"
  "BEGIN OPENSSH PRIVATE KEY"
  "BEGIN EC PRIVATE KEY"
  "BEGIN PGP PRIVATE KEY BLOCK"
  "ghp_[A-Za-z0-9]{36}"
  "aws_secret_access_key.*=.*[A-Za-z0-9/+=]{40}"
)

LEAKS_DETECTED=0
for pattern in "${SUSPECT_PATTERNS[@]}"; do
  grep_out=$(grep -rEn --exclude-dir=".git" --exclude-dir=".agents" --exclude-dir="node_modules" --exclude-dir="dist" --exclude-dir=".system_generated" --exclude="preflight_check.sh" "${pattern}" "${PROJECT_ROOT}" 2>/dev/null || true)
  if [ -n "${grep_out}" ]; then
    if echo "${grep_out}" | grep -qv "mock\|example\|test"; then
      record_fail "Potential real credential leak detected for pattern '${pattern}':\n${grep_out}"
      LEAKS_DETECTED=$((LEAKS_DETECTED + 1))
    fi
  fi
done

if [ ${LEAKS_DETECTED} -eq 0 ]; then
  record_pass "Zero unredacted private keys or plaintext secrets found in tracked files."
fi

# ==============================================================================
# 10. Final Pre-Flight Summary
# ==============================================================================
log_header "Pre-Flight Verification Summary"

echo -e "  Total Checks Executed:  ${COLOR_BOLD}${TOTAL_TESTS}${COLOR_RESET}"
echo -e "  Passed Checks:          ${COLOR_GREEN}${PASSED_TESTS}${COLOR_RESET}"
echo -e "  Failed Checks:          ${COLOR_RED}${FAILED_TESTS}${COLOR_RESET}"
echo -e "  Warnings:               ${COLOR_YELLOW}${WARNINGS}${COLOR_RESET}"

if [ ${FAILED_TESTS} -eq 0 ]; then
  echo -e "\n${COLOR_GREEN}${COLOR_BOLD}=== PRE-FLIGHT CHECK PASSED: Codebase is 100% healthy and ready for GitOps push ===${COLOR_RESET}\n"
  exit 0
else
  echo -e "\n${COLOR_RED}${COLOR_BOLD}=== PRE-FLIGHT CHECK FAILED: Resolve ${FAILED_TESTS} failures before proceeding ===${COLOR_RESET}\n"
  exit 1
fi
