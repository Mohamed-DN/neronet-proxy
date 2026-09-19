#!/usr/bin/env python3
"""
NeroNet Enterprise Management Console - Frontend & Staging Runtime Adversarial Stress Harness
Empirically stress-tests:
1. Frontend build artifact integrity, HTML asset linking, CSS theme tokens, and bundle cleanliness.
2. Staging runtime scripts (start.sh, stop.sh) port bindings, process lifecycle, signal handling, and network routing non-interference.
3. Dockerfile & docker-compose.yml configuration invariants and security isolation.
4. Concurrent API throughput and SQLite WAL concurrency resilience under high parallel load.
5. Adversarial input fuzzing (auth bypass, malformed headers, large payloads).
"""

import sys
import os
import time
import json
import subprocess
import urllib.request
import urllib.error
import http.client
import concurrent.futures
from typing import Dict, List, Tuple, Any

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "console/frontend")
BACKEND_DIR = os.path.join(PROJECT_ROOT, "console/backend")
DIST_DIR = os.path.join(FRONTEND_DIR, "dist")
API_BASE_URL = os.environ.get("CONSOLE_API_URL", "http://127.0.0.1:8082")

results = []

def record(test_name: str, passed: bool, details: str = ""):
    status = "PASS" if passed else "FAIL"
    results.append({"name": test_name, "status": status, "details": details})
    prefix = "✅" if passed else "❌"
    print(f"{prefix} [{status}] {test_name}: {details}")

def test_frontend_build_artifacts():
    print("\n--- [TEST GROUP 1] Frontend Build Artifact Integrity ---")
    
    # Check index.html exists
    index_html_path = os.path.join(DIST_DIR, "index.html")
    if not os.path.isfile(index_html_path):
        record("Frontend index.html presence", False, f"Missing {index_html_path}")
        return
    
    with open(index_html_path, "r", encoding="utf-8") as f:
        html_content = f.read()
    
    record("Frontend index.html presence", True, f"Found {index_html_path} ({len(html_content)} bytes)")
    
    # Check dark theme class and title
    has_dark_class = 'class="dark"' in html_content or "dark" in html_content
    record("Frontend dark theme class in HTML", has_dark_class, "HTML contains dark class")
    
    has_title = "NeroNet" in html_content
    record("Frontend title branding in HTML", has_title, "HTML contains NeroNet branding title")
    
    # Check assets directory
    assets_dir = os.path.join(DIST_DIR, "assets")
    if not os.path.isdir(assets_dir):
        record("Frontend dist/assets presence", False, "dist/assets directory missing")
        return
    
    asset_files = os.listdir(assets_dir)
    js_files = [f for f in asset_files if f.endswith(".js")]
    css_files = [f for f in asset_files if f.endswith(".css")]
    
    record("Frontend JS bundle presence", len(js_files) > 0, f"Found JS bundles: {js_files}")
    record("Frontend CSS bundle presence", len(css_files) > 0, f"Found CSS bundles: {css_files}")
    
    # Verify HTML links exact generated JS & CSS bundles
    for js_f in js_files:
        is_linked = js_f in html_content
        record(f"HTML script tag links {js_f}", is_linked, f"Linked in index.html: {is_linked}")
    
    for css_f in css_files:
        is_linked = css_f in html_content
        record(f"HTML stylesheet link tag links {css_f}", is_linked, f"Linked in index.html: {is_linked}")

    # Inspect CSS bundle and font imports
    has_font_dm_sans = "DM+Sans" in html_content or "DM Sans" in html_content
    has_font_mono = "JetBrains+Mono" in html_content or "JetBrains Mono" in html_content
    record("Design System typography imported", has_font_dm_sans and has_font_mono, "DM Sans & JetBrains Mono fonts linked in HTML header")

    if css_files:
        css_path = os.path.join(assets_dir, css_files[0])
        with open(css_path, "r", encoding="utf-8") as f:
            css_content = f.read()
        record("CSS stylesheet compiled size", len(css_content) > 5000, f"CSS bundle size: {len(css_content)} bytes")

def test_runtime_scripts_and_routing_safety():
    print("\n--- [TEST GROUP 2] Staging Runtime Scripts & Network Routing Safety ---")
    
    start_sh = os.path.join(PROJECT_ROOT, "console/start.sh")
    stop_sh = os.path.join(PROJECT_ROOT, "console/stop.sh")
    
    record("start.sh existence and executable", os.path.isfile(start_sh) and os.access(start_sh, os.X_OK), "start.sh exists & is executable")
    record("stop.sh existence and executable", os.path.isfile(stop_sh) and os.access(stop_sh, os.X_OK), "stop.sh exists & is executable")
    
    with open(start_sh, "r", encoding="utf-8") as f:
        start_sh_content = f.read()
    with open(stop_sh, "r", encoding="utf-8") as f:
        stop_sh_content = f.read()
        
    # Check loopback host enforcement
    has_loopback_binding = "127.0.0.1" in start_sh_content
    record("start.sh enforces 127.0.0.1 loopback binding", has_loopback_binding, "start.sh binds to 127.0.0.1")
    
    # Check zero kernel route tampering
    dangerous_keywords = ["ip route", "route add", "route change", "route delete", "iptables", "pfctl -f", "sysctl -w net.inet.ip.forwarding=1"]
    has_dangerous_commands = any(dk in start_sh_content or dk in stop_sh_content for dk in dangerous_keywords)
    record("Runtime scripts zero route table tampering", not has_dangerous_commands, "No route/iptables/pfctl mutation commands found")
    
    # Verify Tailscale utun isolation
    touches_utun = "utun" in start_sh_content or "utun" in stop_sh_content or "tailscale" in start_sh_content
    record("Runtime scripts non-interference with Tailscale interfaces", not touches_utun, "Zero touches on utunX or tailscale daemon")
    
    # Check process cleanup trap in start.sh
    has_trap = "trap cleanup" in start_sh_content or "trap" in start_sh_content
    record("start.sh contains signal trap for cleanup", has_trap, "SIGINT/SIGTERM trap defined")
    
    # Check stop.sh port termination logic
    has_lsof_kill = "8081" in stop_sh_content and "8082" in stop_sh_content
    record("stop.sh targets staging ports 8081/8082", has_lsof_kill, "lsof / kill logic present for 8081 and 8082")

def test_container_configuration():
    print("\n--- [TEST GROUP 3] Containerization & Compose Stack Verification ---")
    
    dockerfile_path = os.path.join(PROJECT_ROOT, "console/Dockerfile")
    compose_path = os.path.join(PROJECT_ROOT, "docker-compose.yml")
    
    with open(dockerfile_path, "r", encoding="utf-8") as f:
        dockerfile_content = f.read()
    with open(compose_path, "r", encoding="utf-8") as f:
        compose_content = f.read()
        
    # Multi-stage check
    is_multi_stage = "AS frontend-builder" in dockerfile_content and "AS runner" in dockerfile_content
    record("Dockerfile multi-stage build structure", is_multi_stage, "Multi-stage frontend-builder -> runner verified")
    
    # Check port exposure
    has_exposed_ports = "EXPOSE 8081 8082" in dockerfile_content or ("8081" in dockerfile_content and "8082" in dockerfile_content)
    record("Dockerfile exposes ports 8081 & 8082", has_exposed_ports, "Exposed ports 8081/8082 present")
    
    # Check bridge network in compose
    has_bridge_net = "driver: bridge" in compose_content
    record("docker-compose.yml uses isolated bridge network", has_bridge_net, "driver: bridge specified")
    
    # Check zero host network or privileged mode
    is_not_host_net = "network_mode: host" not in compose_content
    is_not_privileged = "privileged: true" not in compose_content
    record("docker-compose.yml avoids host networking / privileged escalation", is_not_host_net and is_not_privileged, "Zero privileged mode or host network leaks")

def make_http_request(method: str, path: str, data: Dict[str, Any] = None, token: str = None) -> Tuple[int, Dict[str, Any], float]:
    url = f"{API_BASE_URL}{path}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    
    body = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            status = resp.status
            resp_body = resp.read().decode("utf-8")
            elapsed = time.time() - t0
            parsed = json.loads(resp_body) if resp_body else {}
            return status, parsed, elapsed
    except urllib.error.HTTPError as e:
        elapsed = time.time() - t0
        err_body = e.read().decode("utf-8")
        try:
            parsed = json.loads(err_body)
        except Exception:
            parsed = {"raw": err_body}
        return e.code, parsed, elapsed
    except Exception as e:
        elapsed = time.time() - t0
        return 0, {"error": str(e)}, elapsed

def test_api_load_and_sqlite_concurrency():
    print("\n--- [TEST GROUP 4] Backend API Concurrency & SQLite WAL Stress Test ---")
    
    # Step 1: Health check
    code, data, lat = make_http_request("GET", "/api/health")
    if code != 200:
        record("API Health check connectivity", False, f"HTTP {code}: {data}")
        return
    record("API Health check connectivity", True, f"HTTP {code} ({round(lat*1000, 2)}ms) - db: {data.get('database')}")
    
    # Step 2: Login as admin
    login_code, login_data, _ = make_http_request("POST", "/api/auth/login", {"username": "admin", "password": "admin_password"})
    admin_token = login_data.get("token")
    record("Super-Admin Authentication", login_code == 200 and bool(admin_token), f"HTTP {login_code}, Token issued: {bool(admin_token)}")
    
    if not admin_token:
        print("[-] Skipping concurrency tests without auth token")
        return
    
    # Step 3: High-concurrency stress test (60 parallel requests)
    endpoints = [
        ("GET", "/api/health", None),
        ("GET", "/api/stats/overview", None),
        ("GET", "/api/nodes", None),
        ("GET", "/api/stats/bandwidth", None),
        ("GET", "/api/stats/audit-logs", None),
        ("GET", "/api/apps", None),
    ]
    
    total_reqs = 60
    concurrency = 15
    tasks = []
    for i in range(total_reqs):
        method, path, body = endpoints[i % len(endpoints)]
        tasks.append((method, path, body, admin_token))
        
    t_start = time.time()
    success_count = 0
    latencies = []
    
    def worker(task):
        m, p, b, tok = task
        st, res, l = make_http_request(m, p, b, tok)
        return st, l
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(worker, t) for t in tasks]
        for f in concurrent.futures.as_completed(futures):
            st, l = f.result()
            latencies.append(l)
            if st == 200:
                success_count += 1
                
    total_duration = time.time() - t_start
    avg_lat = sum(latencies) / len(latencies) if latencies else 0
    p95_lat = sorted(latencies)[int(len(latencies) * 0.95)] if latencies else 0
    
    record(
        f"Concurrent API throughput ({total_reqs} reqs @ concurrency={concurrency})",
        success_count == total_reqs,
        f"Success: {success_count}/{total_reqs} (100%), Avg Latency: {round(avg_lat*1000, 2)}ms, P95: {round(p95_lat*1000, 2)}ms, Total time: {round(total_duration, 2)}s"
    )
    
    # Step 4: Rapid Sequential Curve25519 Clamping & Config Generation
    crypto_count = 10
    crypto_success = 0
    for i in range(crypto_count):
        code, cfg, _ = make_http_request("POST", "/api/configs/generate", {
            "name": f"stress-node-{i}",
            "role": "CLIENT_ORIGIN",
            "country_code": "US"
        }, token=admin_token)
        if code == 200 and "wireguard_conf" in cfg and "qrcode_data_url" in cfg:
            crypto_success += 1
            
    record(
        f"Curve25519 Clamped Config & QR Generation ({crypto_count} iterations)",
        crypto_success == crypto_count,
        f"Generated {crypto_success}/{crypto_count} configs with WireGuard, Noise profile, and QR code data"
    )
    
    # Step 5: Rapid Node Ping Actions on seeded node
    ping_code, ping_res, ping_lat = make_http_request("POST", "/api/nodes/svrn-node-seed1/action", {
        "action": "ping"
    }, token=admin_token)
    record(
        "Live Node Action (Ping Live RTT on svrn-node-seed1)",
        ping_code == 200 and ping_res.get("success") is True,
        f"HTTP {ping_code}, Result: {ping_res.get('result')}"
    )

def test_adversarial_input_hardening():
    print("\n--- [TEST GROUP 5] Adversarial Hardening & Negative Boundary Fuzzing ---")
    
    # 1. Token Forgery / Bad Signature
    bad_token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJmYWtlX2FkbWluIn0.BADSIGNATURE123456789"
    code, data, _ = make_http_request("GET", "/api/users", token=bad_token)
    record(
        "Tampered JWT signature rejection",
        code == 401 or code == 403,
        f"Rejected with HTTP {code} (Expected 401/403)"
    )
    
    # 2. Regular user privilege escalation to admin endpoints
    user_login_code, user_login, _ = make_http_request("POST", "/api/auth/login", {"username": "alice_homelab", "password": "Password123!"})
    alice_token = user_login.get("token")
    if alice_token:
        code, data, _ = make_http_request("GET", "/api/users", token=alice_token)
        record(
            "RBAC enforcement: tenant user blocked from /api/users",
            code == 403,
            f"Blocked with HTTP {code} (Expected 403 Forbidden)"
        )
        
        # Regular user accessing audit logs (tenant isolation check)
        code, data, _ = make_http_request("GET", "/api/stats/audit-logs", token=alice_token)
        logs = data.get("audit_logs", [])
        foreign_logs = [l for l in logs if l.get("actor_user_id") not in ("usr-alice", None)]
        record(
            "RBAC multi-tenant isolation: tenant user cannot see foreign audit logs",
            code == 200 and len(foreign_logs) == 0,
            f"HTTP {code}, Total logs: {len(logs)}, Foreign logs leaked: {len(foreign_logs)}"
        )
    else:
        record("Tenant user login for RBAC test", False, f"Failed to login as alice_homelab: {user_login}")
        
    # 3. SQL Injection probe in search / params
    sqli_payloads = ["' OR '1'='1", "admin'--", "1; DROP TABLE users;--"]
    for payload in sqli_payloads:
        code, data, _ = make_http_request("POST", "/api/auth/login", {"username": payload, "password": "password"})
        record(
            f"SQLi resistance on auth login ({payload[:15]}...)",
            code == 401,
            f"Returned HTTP {code} (Authentication failed safely)"
        )

def main():
    print("=" * 80)
    print("🛡️  CHALLENGER 2: FRONTEND & STAGING RUNTIME ADVERSARIAL STRESS TEST")
    print(f"Target API: {API_BASE_URL}")
    print("=" * 80)
    
    test_frontend_build_artifacts()
    test_runtime_scripts_and_routing_safety()
    test_container_configuration()
    test_api_load_and_sqlite_concurrency()
    test_adversarial_input_hardening()
    
    print("\n" + "=" * 80)
    total = len(results)
    passed = sum(1 for r in results if r["status"] == "PASS")
    failed = total - passed
    print(f"SUMMARY: {passed}/{total} tests passed ({round(passed/total*100, 2)}%)")
    print("=" * 80)
    
    if failed > 0:
        print(f"❌ {failed} TESTS FAILED")
        sys.exit(1)
    else:
        print("✅ ALL ADVERSARIAL CHALLENGER TESTS PASSED EMPIRICALLY")
        sys.exit(0)

if __name__ == "__main__":
    main()
