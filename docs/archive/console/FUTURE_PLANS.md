> Historical document, not maintained. It is a version 5 wish list written before the current plan and does not describe the current code. For the current state read [the handbook](../../HANDBOOK.md).

# NeroNet v5.0 (DarkNero Mesh): Next-Generation Architecture Roadmap & Technical Specification

## Executive Summary

NeroNet v4.0 established an enterprise-grade, decentralized peer-to-peer mesh and residential proxy routing platform leveraging Noise IKpsk2 cryptography, userspace TCP/IP netstack sandboxing, multi-cloud declarative orchestration, and NetBird-compatible dynamic access controls.

**NeroNet v5.0 (DarkNero Mesh)** represents the quantum leap into ubiquity, line-rate kernel acceleration, post-quantum cryptographic resilience, and global zero-trust governance on `DARKNERO.COM` (`neronet.darknero.com`). This document outlines the definitive architectural blueprint, engineering specifications, protocol wire formats, and deployment strategies for v5.0.

```
+---------------------------------------------------------------------------------------------------------------+
|                              NERONET v5.0 (DARKNERO MESH) GLOBAL ARCHITECTURE                                 |
+---------------------------------------------------------------------------------------------------------------+
|                                                                                                               |
|  +---------------------------------------------------------------------------------------------------------+  |
|  |                FEDERATED ZERO-TRUST CONTROL PLANE (Multi-Region Raft + Wasm Plugins)                    |  |
|  |  * Quantum-Safe Identity (ML-DSA-65)       * Dynamic Topology & VIP Swarm                               |  |
|  |  * Continuous Behavioral Risk Engine       * Loadable Wasm Traffic Inspection & Transforms              |  |
|  +---------------------------------------------------------------------------------------------------------+  |
|                                                     |                                                         |
|         +-------------------------------------------+-------------------------------------------+             |
|         |                                           |                                           |             |
|  +------v------------------------------------+  +---v------------------------------------+  +---v----------+  |
|  |   eBPF / XDP LINE-RATE DERP SWITCHING     |  |     MULTIPATH QUIC (MPQUIC) ENGINE     |  | ZERO-KNOW-   |  |
|  | * AF_XDP Zero-Copy Kernel Ring Buffers    |  | * Cellular + Wi-Fi Bandwidth Agg       |  | LEDGE DATA   |  |
|  | * 100Gbps Line-Rate DERP-v5 Relay         |  | * Sub-Millisecond Path Failover        |  | PLANE (E2EE) |  |
|  | * In-Kernel Anti-Probing Deep Decoy       |  | * Congestion Control (BBRv3/MP)        |  | Argon2id/GCM |  |
|  +-------------------------------------------+  +----------------------------------------+  +--------------+  |
|                                                     |                                                         |
|         +-------------------------------------------+-------------------------------------------+             |
|         |                                                                                       |             |
|  +------v---------------------------------------------------------------------------------------v----------+  |
|  |                      CROSS-PLATFORM NATIVE CLIENT & CLOUD PC ECOSYSTEM (v5.0 Native)                    |  |
|  |  +--------------------+  +--------------------+  +--------------------+  +---------------------------+  |  |
|  |  |   iOS & iPadOS     |  |       macOS        |  |      Android       |  |  Windows & Linux Desktop  |  |  |
|  |  | Swift 6 / SwiftUI  |  | AppKit / SystemExt |  | Jetpack Compose    |  | Tauri 2.0 / WinTUN / WRY  |  |  |
|  |  | NEPacketTunnel     |  | Touch ID / Menubar |  | VpnService + JNI   |  | Direct OS Shortcut Hooks  |  |  |
|  |  +--------------------+  +--------------------+  +--------------------+  +---------------------------+  |  |
|  |                                                                                                         |  |
|  |  * Sovereign Remote Desktop: WebRTC 4K/120FPS (<30ms RTT, Opus, AV1/H.264 HW NVENC/VA-API, USB/IP)     |  |
|  |  * Zero-Knowledge E2EE: Client-Side Chunk Encryption (Nextcloud/Vault/Immich, Signal Ratchet, SSS (3,5))|  |
|  |  * Post-Quantum Hybrid Handshake: ML-KEM-768 (Kyber) + X25519 in Noise IKpsk2 Handshake                |  |
|  +---------------------------------------------------------------------------------------------------------+  |
+---------------------------------------------------------------------------------------------------------------+
```

---

### 1. Native Client Applications Architecture

The core tenet of NeroNet v5.0 (DarkNero Mesh) is frictionless consumer and enterprise client adoption across all major desktop and mobile operating systems. All native clients leverage a shared high-performance Go core (`libsovereign`) compiled via Gomobile and CGO, encapsulated by platform-native modern declarative user interfaces.

### 1.1 Shared Core Architecture (`pkg/client/core`)

The Go core is packaged as:
- **Apple (iOS/macOS)**: `SovereignCore.xcframework` (C-archive / Gomobile bindings for arm64/x86_64).
- **Android**: `libsovereign.so` (JNI dynamic library for `arm64-v8a`, `armeabi-v7a`, `x86_64`) + `SovereignCore.aar`.
- **Windows**: `sovereign-core.dll` + WinTUN userspace ring driver.
- **Linux**: `sovereign-daemon` standalone binary with D-Bus IPC interface.

```
+-----------------------------------------------------------------------------------+
|                        PLATFORM-SPECIFIC NATIVE UI LAYER                          |
|  (SwiftUI on Apple, Jetpack Compose on Android, Wails/Fyne/GTK-4 on Desktop)     |
+-----------------------------------------------------------------------------------+
                                         |
                                 (IPC / JNI / C-Bridge)
                                         |
+----------------------------------------v------------------------------------------+
|                  NERONET SHARED CORE ENGINE (Gomobile / CGO)                      |
|  +-----------------------------------------------------------------------------+  |
|  |  Virtual Network Adapter Interface (TUN / VpnService / NEPacketTunnel)      |  |
|  +-----------------------------------------------------------------------------+  |
|  |  gVisor Netstack (TCP/IP/UDP Userspace Protocol Stack)                      |  |
|  +-----------------------------------------------------------------------------+  |
|  |  Post-Quantum Noise Engine (ML-KEM-768 + X25519 + ChaCha20-Poly1305)         |  |
|  +-----------------------------------------------------------------------------+  |
|  |  MPQUIC Engine / Adaptive Disco-v5 Hole Punching / DERP-v5 Relay Multiplexer|  |
|  +-----------------------------------------------------------------------------+  |
|  |  Anti-Leak DoH Multi-Resolver + RFC 1918 Bogon Isolation + Port Filter      |  |
|  +-----------------------------------------------------------------------------+  |
|  |  Dynamic Route Selector, Latency Matrix Engine & Battery Guardian           |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

---

### 1.2 Apple iOS & iPadOS Architecture

#### Key Capabilities & Technologies
- **UI Framework**: Modern SwiftUI with iOS 17+ Observation framework and Swift Concurrency (`async`/`await`, `Actor` isolation).
- **Tunneling Mechanism**: `NetworkExtension.framework` utilizing `NEPacketTunnelProvider`.
- **Key Storage**: Hardware Secure Enclave via Keychain Services (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
- **On-Demand Wi-Fi Rules**: Automated activation via `NEOnDemandRuleConnect` on untrusted SSIDs and cellular data; auto-disconnect on trusted enterprise SSIDs.
- **Push-to-Wake Reconnect**: Apple Push Notification service (APNs) Silent Voip/Background Push triggering tunnel wake-up and key re-negotiation.

#### Data Flow & Lifecycle
1. User activates VPN via toggle or On-Demand rule.
2. iOS starts `PacketTunnelProvider` extension in a separate 15MB/50MB memory-constrained process.
3. The Extension calls `SovereignCoreStartTunnel(fd, configJSON)`.
4. Packets from virtual TUN interface (`packetFlow.readPackets`) are handed to Go userspace netstack without context-switching penalties.
5. Inbound mesh traffic is decrypted via hybrid ML-KEM-768/X25519 and written back to `packetFlow.writePackets`.

---

### 1.3 Apple macOS Architecture

#### Key Capabilities & Technologies
- **UI Framework**: AppKit / SwiftUI Menubar companion with compact popover interface and full dashboard window.
- **Tunneling**: `NEPacketTunnelProvider` as a macOS System Extension (`com.apple.sysext.network-extension`) running rootless with sandboxed capabilities.
- **Per-App Split Tunneling**: `NEAppProxyProvider` and process path matching (`/Applications/Browser.app`) allowing granular routing of developer tools, browsers, or terminal sessions.
- **Biometric Security**: Local authentication policy (`LAPolicyDeviceOwnerAuthenticationWithBiometrics`) requiring Touch ID or Apple Watch proximity confirmation before modifying routing modes or viewing private keys.

---

### 1.4 Android Architecture

#### Key Capabilities & Technologies
- **UI Framework**: Kotlin + Jetpack Compose with Material 3 dynamic color theme and Material You design guidelines.
- **Tunneling Mechanism**: `android.net.VpnService` with direct file descriptor passing (`vpnInterface.detachFd()`) into Go runtime via Gomobile JNI.
- **Always-on VPN & Lockdown**: Full support for Android enterprise `ALWAYS_ON_VPN` and `HTTP_PROXY` per-app isolation.
- **Per-App Routing (Split Tunneling)**: Granular package selection (`builder.addAllowedApplication("com.android.chrome")` / `builder.addDisallowedApplication(...)`).
- **Battery Optimization Bypass**: Foreground Service with persistent low-overhead notification (`NotificationChannel` with `IMPORTANCE_MIN`), `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` prompt, and `JobScheduler` keepalives.

---

### 1.5 Windows Architecture

#### Key Capabilities & Technologies
- **UI Framework**: Wails v2 (Go + Svelte/React web frontend with native WebView2 bindings) or lightweight Fyne native GUI.
- **Driver Integration**: High-performance WinTUN kernel driver (`wintun.dll`), achieving >10 Gbps userspace I/O ring buffer throughput.
- **Background Daemon**: Windows Service (`SovereignMeshService`) registered via `advapi32.dll` with auto-start and crash recovery.
- **Packaging & Delivery**: Signed MSIX / MSI installers with WiX Toolset, embedded code signing via Azure Key Vault / DigiCert HSM, and built-in auto-updater with Ed25519 signature validation.

---

### 1.6 Linux Architecture

#### Key Capabilities & Technologies
- **CLI & Daemon**: Lightweight `sovereign-daemon` daemon with systemd integration (`sovereign.service`), `dbus` notification events, and POSIX socket IPC (`/run/sovereign/mesh.sock`).
- **Desktop UI**: GTK-4 / Libadwaita desktop app and AppIndicator/KStatusNotifierItem system tray applet.
- **Network Stack**: WireGuard kernel module integration where available, with seamless automatic fallback to userspace `water/tun` or `gVisor netstack`.

---

### 1.7 Rich Client App UI Architecture & Interactive Control Specifications

The NeroNet (DARKNERO.COM / DarkNero Mesh) native client applications feature an intuitive, cybersecurity-grade interface designed to give users granular control over their cryptographic privacy, egress paths, and device performance.

```
+-------------------------------------------------------------------------------------------------------+
|                                  NERONET RICH CLIENT UI COMPONENT HIERARCHY                           |
+-------------------------------------------------------------------------------------------------------+
|                                                                                                       |
|  +-------------------------------------------------------------------------------------------------+  |
|  | [1] STATUS & TELEMETRY HEADER                                                                   |  |
|  | - Master Connection Toggle (Instant Connect / Disconnect)                                        |  |
|  | - Protocol Badge (Noise IKpsk2 / ML-KEM-768 Hybrid PQ)                                           |  |
|  | - Real-time Bandwidth & Latency HUD (Downlink, Uplink, EWMA RTT, Jitter, Packet Loss)            |  |
|  +-------------------------------------------------------------------------------------------------+  |
|                                                  |                                                    |
|  +-----------------------------------------------v-------------------------------------------------+  |
|  | [2] EGRESS ROUTING MATRIX & MODE SELECTOR (Tab / Segmented Bar)                                 |  |
|  |                                                                                                 |  |
|  |   Mode A: [Country Exit Selector]       Mode B: [Direct Host Anchor]    Mode C: [3-Hop Onion]  |  |
|  |   - Searchable Country & City List       - Specific Host ID / PubKey     - Random Mesh Circuit |  |
|  |   - Composite Health Score (0-100)       - Device Alias & ASN Anchor     - Circuit Peeling HUD |  |
|  |   - Live Ping (ms) & Avail Bandwidth     - Direct P2P NAT Status         - Jitter Obfuscation  |  |
|  +-------------------------------------------------------------------------------------------------+  |
|                                                  |                                                    |
|  +-----------------------------------------------v-------------------------------------------------+  |
|  | [3] SECURITY, PRIVACY & SYSTEM GUARDIAN TOGGLES                                                 |  |
|  | - Strict Kill Switch (Zero-Leak Firewall)      - Per-App Split Tunneling (App Bypass List)     |  |
|  | - Trusted Wi-Fi On-Demand (SSID Whitelist)      - Battery Guardian (<15% Bridge Auto-Pause)     |  |
|  | - Anti-Leak DNS over HTTPS (DoH Quad9/Cloudflare) - Quantum-Safe Handshake Enforcement (ML-KEM)   |  |
|  +-------------------------------------------------------------------------------------------------+  |
|                                                  |                                                    |
|  +-----------------------------------------------v-------------------------------------------------+  |
|  | [4] LIVE TOPOLOGY & MESH TRAFFIC INSPECTOR                                                      |  |
|  | - Interactive Node Particle Visualizer         - Active Peer Table & Direct P2P vs Relay State  |  |
|  +-------------------------------------------------------------------------------------------------+  |
+-------------------------------------------------------------------------------------------------------+
```

#### 1. Country Exit Node Selector with Composite Health & Ping Scores
- **Real-Time Country Browser**: Lists all active exit bridge clusters grouped by ISO-3166-1 country code with national flag glyphs, city identifiers, and ASN details.
- **Composite Health Score Algorithm**: Displays an aggregate quality badge (90-100: Green/Optimal, 70-89: Yellow/Good, <70: Orange/Degraded) calculated from:
  $$\text{Score} = 0.35 \times \frac{\text{BW}_{\text{avail}}}{\text{BW}_{\text{max}}} + 0.30 \times \frac{100}{\text{RTT} + 1} + 0.20 \times (1 - \text{Loss}) + 0.15 \times \text{Reputation} - 0.05 \times \text{Jitter}$$
- **Fast Search & Favorites**: Instant prefix filtering across country names, ISO codes, and cities with one-tap pinning to favorites.

#### 2. Specific Host ID Egress Selector (Direct Node Anchoring)
- **Granular Peer Pinning**: Users can anchor their entire device egress to a specific trusted peer node (e.g. `node-us-east-1a-04f8` or public key prefix `e3b0c44298fc...`).
- **Direct P2P Validation Indicator**: Real-time diagnostic badge displaying whether the path to the anchored host is Direct UDP P2P (green lightning bolt) or routed via DERP Relay fallback (blue tunnel icon).
- **Latency & Uptime Telemetry**: Displays exact round-trip ping (sub-millisecond accuracy), packet loss rate, and continuous node uptime.

#### 3. 3-Hop Onion Obfuscation Toggle & Random Residential Mesh Routing
- **Decentralized Multi-Hop Circuit**: When enabled, wraps outbound traffic in 3 concentric layers of ChaCha20-Poly1305 encryption through randomized Entry Relay $\rightarrow$ Intermediate Relay $\rightarrow$ Residential Exit Bridge.
- **Circuit Inspector HUD**: Visualizes the 3 selected nodes, showing their geographic hops, intermediate latency, and randomized timing jitter delay (2ms - 25ms) injected to defeat correlation attacks.
- **Circuit Re-Seed Button**: One-tap instant rotation of intermediate and entry nodes without dropping active TCP socket streams.

#### 4. Enterprise Security & Device Guardian Toggles
- **Strict Kill Switch (Zero-Leak Protection)**: Immediately cuts all default gateway interfaces (Wi-Fi/Cellular/Ethernet) if the cryptographic mesh tunnel experiences an unexpected drop, preventing IPv4/IPv6 plaintext leaks.
- **Per-App Split Tunneling**: Allows users to include or exclude specific applications from the mesh tunnel (e.g. routing developer terminal or web browser through NeroNet while keeping local video games direct).
- **Trusted Wi-Fi On-Demand**: Automatically activates NeroNet mesh protection upon connecting to public or untrusted Wi-Fi hotspots, while entering low-power standby on trusted home/office SSIDs.
- **Battery Guardian (<15% Auto-Pause)**: Intelligent battery monitor that automatically pauses the client's exit bridge routing capability (stops routing other peers' traffic) whenever battery falls below 15%, conserving battery life while keeping user's own VPN active.

#### 5. Instant QR code Onboarding
- **Zero-Friction Camera Scan**: Control plane generates single-use signed registration tokens encoded as SVG/PNG QR code payloads (`svrn://join?token=JWT&relay=wss://relay.mesh.io:443&kem=MLKEM768`).
- **Instant Pair & Key Exchange**: Mobile cameras scan and onboard nodes in <300ms with zero manual key copying.

---

### 1.8 Platform-Specific Visual Wireframes & Component Hierarchies

#### A. iOS & iPadOS Visual Wireframe (SwiftUI 6 / NavigationStack)

```
+--------------------------------------------------+
|  [|||]  NeroNet Mesh         (i) Settings    [?] |
+--------------------------------------------------+
|                                                  |
|       +----------------------------------+       |
|       |     (●) CONNECTED (00:42:18)     |       |
|       |      VIP: 100.64.0.42 (US-East)  |       |
|       +----------------------------------+       |
|                                                  |
|  [  DISCONNECT MASTER TOGGLE  (Swipe to Stop)  ] |
|                                                  |
|  PROTOCOL: Hybrid ML-KEM-768 + Noise IKpsk2      |
|  RTT: 18ms | JITTER: 1.2ms | LOSS: 0.0%          |
|  DOWN: 84.2 Mbps  ▲ | UP: 42.1 Mbps  ▼          |
|                                                  |
|  ROUTING EGRESS MODE:                            |
|  [ Country ]   [ Direct Host ]   [ 3-Hop Onion*] |
|                                                  |
|  SELECTED EXIT: 🇺🇸 United States (Ashburn, VA)   |
|  Health Score: 98/100 (Optimal) | RTT: 18ms      |
|  [ Change Country / View 48 Global Nodes > ]     |
|                                                  |
|  SECURITY & BATTERY GUARDIANS:                   |
|  [ON ] Strict Kill Switch (Leak Prevention)      |
|  [ON ] Per-App Split Tunneling (4 Apps Routed)   |
|  [ON ] Trusted Wi-Fi On-Demand ("Home_5G" safe)  |
|  [ON ] Battery Guardian (<15% Bridge Pause)      |
|                                                  |
|  [ 🌐 View Live Particle Topology Simulation  ]  |
+--------------------------------------------------+
|   [Mesh Home]     [Nodes]     [Logs]     [Config]|
+--------------------------------------------------+
```

#### B. macOS Visual Wireframe (AppKit / SwiftUI Menubar Companion + Window)

```
+----------------------------------------------------------------------------------------------------+
|  NeroNet Mesh v4.0 (DARKNERO.COM) -- Production Node Control                            [ _ ][ □ ][ X ] |
+----------------------------------------------------------------------------------------------------+
|  [Sidebar]          |  LIVE MESH TOPOLOGY & ACTIVE CIRCUIT                                         |
|                     |  +------------------------------------------------------------------------+  |
|  * Overview         |  |   [Node: Local] ---> [Relay: Frankfurt] ---> [Exit: Zurich-04]       |  |
|  * Nodes (142)      |  |   Mode: 3-Hop Onion Obfuscation | Jitter: 8.4ms | Path: Direct P2P     |  |
|  * ACL Policies     |  +------------------------------------------------------------------------+  |
|  * App Split Tunnel |                                                                              |
|  * Cryptography     |  REAL-TIME THROUGHPUT & TELEMETRY HUD                                        |
|  * Audit Logs       |  [Graph: 100 Mbps Downlink =========] 92.4 Mbps                              |
|                     |  [Graph: 50 Mbps Uplink    ======   ] 38.1 Mbps                              |
|  -----------------  |  Ping: 22ms | Window: 1024 frames | Replay Protection: 0 Drops               |
|  Connection Status: |                                                                              |
|  [● ACTIVE - SECURE]|  ROUTING CONTROLS:                                                           |
|  Exit: Switzerland  |  Country Exit: [ Switzerland (ZH) ▾ ] Health: 99/100 (5ms ping)             |
|  VIP: 100.64.0.19   |  Host Anchor:  [ None (Country Mode Active)                         ▾ ]      |
|  KEM: ML-KEM-768    |  [x] Enable 3-Hop Onion Obfuscation (Random Residential Mesh Routing)       |
|                     |                                                                              |
|  Security Toggles:  |  SYSTEM GUARDIANS:                                                           |
|  [x] Kill Switch    |  [x] Strict Kill Switch (pf firewall anchor active)                          |
|  [x] Split Tunnel   |  [x] Per-App Split Tunneling (Include: Safari, Chrome, Terminal, Slack)      |
|  [x] Wi-Fi Auto     |  [x] Trusted Wi-Fi On-Demand (Bypass on: "Corporate-HQ-Secure")              |
|  [x] Battery Guard  |  [x] Battery Guardian (Auto-pause exit bridge at <15% battery)              |
+----------------------------------------------------------------------------------------------------+
```

#### C. Android Visual Wireframe (Jetpack Compose / Material 3)

```
+--------------------------------------------------+
|  =  NeroNet Mesh (DARKNERO)  (PQ) [QR Scan] [:] |
+--------------------------------------------------+
|                                                  |
|     +--------------------------------------+     |
|     |  Status: SECURE & CONNECTED (Wire)   |     |
|     |  Overlay IP: 100.64.0.88             |     |
|     |  Encryption: ML-KEM-768 + X25519     |     |
|     +--------------------------------------+     |
|                                                  |
|     [  ● DISCONNECT (Hold to Deactivate) ]       |
|                                                  |
|  LIVE METRICS:                                   |
|  Latency: 14ms (Direct P2P) | Loss: 0.0%         |
|  Down: 64.5 MB/s ▲ | Up: 28.1 MB/s ▼             |
|                                                  |
|  EXIT NODE CONFIGURATION:                        |
|  (•) Country Exit: 🇩🇪 Germany (Frankfurt am Main)|
|      Score: 97/100 | Ping: 14ms | BW: 500 Mbps   |
|  ( ) Specific Host ID (Select Node...)           |
|  ( ) 3-Hop Random Mesh Onion Obfuscation         |
|                                                  |
|  SECURITY SETTINGS:                              |
|  [ON ] Always-On VPN & Strict Kill Switch        |
|  [ON ] Per-App Split Tunneling (12 Apps)         |
|  [ON ] Trusted Network Bypass (Wi-Fi SSID)       |
|  [ON ] Battery Guardian (Low Power Auto-Pause)   |
|                                                  |
|  [ ⚡ Run Dynamic Latency Diagnostic Test ]       |
+--------------------------------------------------+
|     [Home]          [Topology]          [Profile]|
+--------------------------------------------------+
```

#### D. Windows Visual Wireframe (Wails v2 / Fluent Dark UI)

```
+----------------------------------------------------------------------------------------------------+
|  NeroNet v4.0 (DARKNERO.COM - WinTUN Driver Line-Rate)                                  [ _ ][ □ ][ X ] |
+----------------------------------------------------------------------------------------------------+
|  [ Quick Connect ]   Status: PROTECTED (100.64.0.12) | Adapter: WinTUN (10 Gbps Ring)               |
|                                                                                                    |
|  +-------------------------------------+  +-----------------------------------------------------+  |
|  | EGRESS SELECTION MATRIX             |  | PERFORMANCE TELEMETRY & ROUTE METRICS               |  |
|  | Mode: [ Country ] [ Host ] [ Onion] |  | Current Latency: 12.4 ms (Direct P2P UDP)           |  |
|  | Target: 🇯🇵 Japan (Tokyo Cloud-01)  |  | Bandwidth In/Out: 112.4 Mbps / 48.6 Mbps            |  |
|  | Quality Score: 99.4/100             |  | Jitter Sigma: 0.8 ms | Loss Rate: 0.00%             |  |
|  | Latency: 12ms | Load: 14%           |  | Post-Quantum Key: ML-KEM-768 Active                 |  |
|  +-------------------------------------+  +-----------------------------------------------------+  |
|                                                                                                    |
|  SYSTEM SECURITY & GUARDIAN POLICIES:                                                              |
|  [√] Strict Kill Switch (WFP - Windows Filtering Platform Zero-Leak Filter Active)                 |
|  [√] Per-App Split Tunneling (Exclude local gaming traffic / Include browsers and Git CLI)          |
|  [√] Trusted Wi-Fi / Ethernet On-Demand Auto-Connect                                                |
|  [√] Battery Guardian (<15% auto-pause background bridge relaying)                                 |
|                                                                                                    |
|  [ View Complete Mesh Route Map ]   [ Test NAT ICE Candidates ]   [ Export WireGuard Config (.conf) ]|
+----------------------------------------------------------------------------------------------------+
```

---


## 2. Post-Quantum Cryptographic Migration Plan

As quantum computing architectures advance towards Shor's algorithm feasibility, classical discrete logarithm systems (Curve25519, RSA, ECDSA) face eventual compromise. Sovereign Mesh v5.0 implements NIST-standardized Post-Quantum Cryptography (PQC) in a hybrid defense-in-depth model.

```
+---------------------------------------------------------------------------------------------------+
|                         HYBRID NOISE_IKpsk2_PQ HANDSHAKE STATE MACHINE                            |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|     INITIATOR (Client)                                          RESPONDER (Exit / Control)        |
|     ------------------                                          --------------------------        |
|                                                                                                   |
|     Ephemeral: e_classic = X25519_Gen()                                                           |
|     Ephemeral PQ: (pk_pq, sk_pq) = ML-KEM-768.KeyGen()                                            |
|                                                                                                   |
|     Handshake Msg 1:                                                                              |
|     -> e_classic, pk_pq, es_classic, ss_classic, Tag1                                             |
|                                                                                                   |
|                                                                 (ct_pq, ss_pq) =                  |
|                                                                   ML-KEM-768.Encaps(pk_pq)        |
|                                                                 Derive Hybrid SS =                |
|                                                                   BLAKE2s(ss_classic || ss_pq)    |
|                                                                                                   |
|                                      Handshake Msg 2:                                             |
|                                      <- e_classic, ct_pq, ee_classic, se_classic, psk, Tag2       |
|                                                                                                   |
|     ss_pq = ML-KEM-768.Decaps(sk_pq, ct_pq)                                                       |
|     Derive Hybrid SS = BLAKE2s(ss_classic || ss_pq)                                               |
|                                                                                                   |
|     ========================================================================================      |
|     ESTABLISHED TRANSPORT CIPHERSTATE: ChaCha20-Poly1305 with Hybrid Quantum-Safe Key             |
|     ========================================================================================      |
+---------------------------------------------------------------------------------------------------+
```

### 2.1 Hybrid Key Encapsulation Mechanism (ML-KEM-768 / Kyber)

- **Algorithm**: NIST FIPS 203 ML-KEM-768 (formerly CRYSTALS-Kyber) combined with Curve25519 in a hybrid Noise pattern: `Noise_IKpsk2_PQ`.
- **Security Goal**: IND-CCA2 security against both classical and quantum adversaries. Even if ML-KEM-768 were broken, classical Curve25519 remains; if Curve25519 is broken by quantum computers, ML-KEM-768 maintains confidentiality.
- **Wire Overhead**: ML-KEM-768 public key (1,184 bytes) and ciphertext (1,088 bytes) are transmitted only during initial handshake (Msg 1 and Msg 2), preserving high performance on steady-state 24-byte SVRN data frames.

### 2.2 Quantum-Safe Digital Signatures (ML-DSA-65 / Dilithium)

- **Algorithm**: NIST FIPS 204 ML-DSA-65 (formerly CRYSTALS-Dilithium).
- **Use Case**: Control Plane node identity attestation, cluster join tokens, and policy manifest code signing.
- **Revocation & Root of Trust**: Hierarchical control plane certificates signed by Offline Root ML-DSA-65 key, with dynamic short-lived intermediate certificates (7-day validity) and CRL distribution over gRPC.

---

## 3. High-Performance Kernel & Transport Innovations

```
+---------------------------------------------------------------------------------------------------+
|                        eBPF / XDP LINE-RATE DERP-v5 SWITCHING PIPELINE                            |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|   100Gbps Ethernet NIC  ---> [ XDP_DRV (Native Driver Hook) ]                                     |
|                                            |                                                      |
|                             +--------------v--------------+                                       |
|                             | BPF Map: Session Router     |                                       |
|                             | Key: SessionID (uint64)     |                                       |
|                             | Val: Target Dest IP & MAC   |                                       |
|                             +--------------+--------------+                                       |
|                                            |                                                      |
|                       +--------------------+--------------------+                                 |
|                       |                                         |                                 |
|               (Matched Valid Route)                     (Probing / Decoy)                         |
|                       |                                         |                                 |
|           [ XDP_TX / Line-Rate Forward ]             [ XDP_PASS -> Decoy Web Engine ]             |
|           Latency: < 450 nanoseconds                 Latency: Standard TCP Handshake              |
|           Throughput: 14.88 Mpps / port                                                           |
+---------------------------------------------------------------------------------------------------+
```

### 3.1 eBPF / XDP Line-Rate Relay Switching

- **Architecture**: In v5.0, DERP relay servers implement an XDP (eXpress Data Path) kernel driver hook (`bpf_derp_switch.c`).
- **Fast-Path Switching**: For established relay sessions, SVRN frames arriving over UDP are parsed in-kernel via eBPF. The 8-byte `SessionID` is looked up in an eBPF `BPF_MAP_TYPE_HASH` map, and the frame is rewritten with destination MAC/IP and redirected immediately via `XDP_TX` with zero memory copies or userspace transitions.
- **Throughput Target**: 100 Gbps line-rate switching per relay node (>14 million packets per second on commodity dual-socket Xeon/EPYC servers).

### 3.2 Multipath QUIC (MPQUIC) Engine

- **RFC 9000 / MPQUIC Integration**: Client nodes utilize concurrent multi-homed path bonding across Wi-Fi (e.g. 5GHz 802.11ax) and Cellular (5G NR mmWave/Sub-6).
- **BBRv3 Multipath Scheduling**: Packets are dynamically striped across active sub-flows according to real-time RTT and loss gradients.
- **Zero-Drop Handover**: Seamless mobility when walking out of Wi-Fi range; cellular subflow immediately carries 100% of traffic with zero TCP reset or session interruption.

### 3.3 Zero-Copy Userspace Ring Buffer (AF_XDP) for Exit Bridges

- High-bandwidth exit bridges utilize `AF_XDP` sockets (`UMEM` memory pools) to bypass kernel network stack overhead while maintaining strict userspace RFC 1918 bogon filtering and anti-abuse port blocking.

---

## 4. Federated Zero-Trust Governance

```
+---------------------------------------------------------------------------------------------------+
|                     FEDERATED MULTI-REGION RAFT & WASM POLICY PIPELINE                            |
+---------------------------------------------------------------------------------------------------+
|                                                                                                   |
|   +--------------------------+    gRPC Consensus    +--------------------------+                  |
|   | Control Plane Leader     |<-------------------->| Control Plane Follower   |                  |
|   | Region: US-East          |                      | Region: EU-Central       |                  |
|   +-------------+------------+                      +-------------+------------+                  |
|                 |                                                 |                               |
|                 +-----------------------+-------------------------+                               |
|                                         |                                                         |
|                         +---------------v---------------+                                         |
|                         | Wasm Dynamic Inspection Engine|                                         |
|                         | (Wasmtime / Extism Sandbox)   |                                         |
|                         +---------------+---------------+                                         |
|                                         |                                                         |
|         +-------------------------------+-------------------------------+                         |
|         |                               |                               |                         |
|  [ Plugin: Geo-DPI ]          [ Plugin: Protocol Scrub ]     [ Plugin: Behavioral Scorer]         |
|  * TLS Fingerprint Camo       * HTTP/3 Header Sanitizer      * Anomaly Risk Assessment            |
+---------------------------------------------------------------------------------------------------+
```

### 4.1 Distributed Multi-Region Raft Control Plane

- **Cross-Cloud Consensus**: Control plane operates as a 5-node or 7-node geographically distributed Raft cluster across AWS, OCI, GCP, and Hetzner.
- **State Replication**: Subnet routes, active peer VIP assignments, dynamic ACLs, and posture requirements are committed via Raft log entries with sub-second replication latency worldwide.
- **Split-Brain Immunity**: Automatic quorum maintenance ensures partition tolerance; disconnected regional nodes serve cached read-only routing topologies.

### 4.2 WebAssembly (Wasm) Extensible Inspection Engine

- **Sandbox Runtime**: Integrated `wasmtime-go` engine allowing administrators to hot-reload traffic inspection and protocol transform plugins without restarting daemons.
- **Capabilities**:
  - Custom Layer 7 protocol scrubbers (stripping tracker headers, obfuscating SNI headers).
  - Dynamic geo-routing heuristics based on external threat feeds.
  - Active deception responses (injecting synthetic decoys against automated port scanners).

### 4.3 Continuous Behavioral Risk Scoring

- **Telemetry Evaluation**: Control plane computes real-time peer risk index (0.00 - 100.00) based on:
  - RTT anomaly & jitter divergence.
  - TCP sequence number entropy.
  - Geolocation drift velocity (impossible travel detection, e.g. US to JP in 5 minutes).
  - Device health posture attestation telemetry.
- **Automated Remediation**: Peers with risk score > 75.00 are automatically moved to isolated quarantine subnet (`100.64.250.0/24`) with restricted access until multi-factor re-attestation succeeds.

---

## 5. Milestone & Release Timeline for v5.0

| Phase | Milestone Name | Scope & Deliverables | Target Timeline |
|---|---|---|---|
| **Phase 1** | Post-Quantum Cryptographic Core | Implement ML-KEM-768 + X25519 hybrid Noise engine & ML-DSA-65 control plane identities | Q1 2027 |
| **Phase 2** | Native Mobile & Desktop Clients | Deliver native iOS (SwiftUI/NEPacketTunnel), Android (Compose/VpnService), macOS, Windows (WinTUN), and Linux apps | Q2 2027 |
| **Phase 3** | eBPF/XDP & MPQUIC Transport | Ship line-rate eBPF relay switching, AF_XDP zero-copy buffers, and Multipath QUIC cellular/Wi-Fi bonding | Q3 2027 |
| **Phase 4** | Federated Raft & Wasm Governance | Multi-region Raft consensus, Wasm dynamic plugin runtime, and continuous behavioral risk scoring | Q4 2027 |
| **Phase 5** | Sovereign Remote Desktop (Cloud PC) | High-fidelity WebRTC streaming engine (<30ms RTT, AV1/H.264 GPU HW encode), Tauri 2.0 native client, USB/IP, multi-monitor | Q1 2028 |
| **Phase 6** | Zero-Knowledge Data Plane (E2EE) | Client-side Argon2id key derivation, E2EE for Nextcloud/Vault/Immich, Signal Double Ratchet, SSS (3,5) disaster recovery | Q2 2028 |
| **Phase 7** | Global Production Rollout | Security audit, chaos testing, enterprise deployment manifests, and NeroNet v5.0 (DarkNero Mesh) GA | Q3 2028 |

---

## 6. Architecture Verification & Invariants

All future contributions to NeroNet v5.0 (DarkNero Mesh) must uphold the following core invariants:
1. **Zero Plaintext Egress**: No unencrypted payload may ever traverse external network interfaces.
2. **Post-Quantum Forward Secrecy**: Handshakes must guarantee hybrid quantum resistance via ML-KEM-768 and Curve25519.
3. **Censorship Evasion by Default**: Geo-fencing remains strictly opt-in; heavily censored jurisdictions (RU, EG, CN, IN) are unconditionally allowed by default.
4. **Strict Bogon Isolation**: RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local, loopback, and CGNAT overlay addresses are dropped at userspace boundaries with zero kernel packet leaks.
5. **Zero Server Plaintext Knowledge**: Server-side storage backends and relational databases must store strictly opaque ciphertext blobs and blind HMAC indexes; server operators possess zero technical capability to decrypt files, passwords, or media.
6. **Sub-30ms Remote Desktop Latency**: Sovereign Cloud PC WebRTC streaming must maintain sub-30ms glass-to-glass round-trip latency over the NeroNet WireGuard mesh under standard broadband network conditions.
7. **Client-Side Cryptographic Key Isolation**: Master encryption keys (`CMK`) are derived strictly on client endpoints via Argon2id and never traverse the network or reach cloud server memory.
8. **Double Ratchet Forward Secrecy & Post-Compromise Security**: Peer-to-peer resource sharing must enforce continuous Diffie-Hellman and symmetric KDF ratcheting.
9. **Deterministic Testing**: 100% test coverage across unit, integration, stress, and 5-tier E2E suites.

---

## 7. Sovereign Remote Desktop: WebRTC High-Fidelity Streaming & Native Client Ecosystem

NeroNet v5.0 evolves remote workstation access from legacy browser-bound Guacamole RDP into an ultra-low-latency, hardware-accelerated **Sovereign Cloud PC** streaming ecosystem powered by the **Selkies-GStreamer** architecture (https://github.com/selkies-project/selkies-gstreamer).

```
+---------------------------------------------------------------------------------------------------------------+
|                      NERONET SOVEREIGN REMOTE DESKTOP (CLOUD PC) WEBRTC & NATIVE ARCHITECTURE                 |
+---------------------------------------------------------------------------------------------------------------+
|                                                                                                               |
|  +---------------------------------------------------------------------------------------------------------+  |
|  |                     NERONET NATIVE DESKTOP CLIENT (Tauri 2.0 / Rust Core + WebView2 / WRY)              |  |
|  |  * Native Display Engine: Dynamic Multi-Monitor Layout, Per-Monitor DPI Virtual Viewport               |  |
|  |  * Low-Level OS Hooks: WH_KEYBOARD_LL (Windows) / CGEventTap (macOS) for Full Shortcut Interception    |  |
|  |  * Input & Peripherals: Raw Mouse/Keyboard, USB/IP Client, Bidirectional Clipboard & File Drop         |  |
|  |  * Audio Engine: Opus Full-band (48kHz Stereo) + Mic Passthrough with Acoustic Echo Cancellation (AEC)   |  |
|  |  * Video Decoder: HW Accelerated (D3D11VA / DXVA2 / VideoToolbox / VA-API) for H.264 & AV1             |  |
|  +---------------------------------------------------------------------------------------------------------+  |
|                                                     |                                                         |
|                     (Direct UDP P2P / ICE Mesh Overlay: WireGuard VIP 100.64.x.y:443)                         |
|                     (SRTP Video/Audio Streams + SCTP DataChannels for Input/USB/Clipboard)                   |
|                                                     |                                                         |
|  +--------------------------------------------------v------------------------------------------------------+  |
|  |          NERONET WEBRTC REMOTE DESKTOP HOST / GATEWAY (Selkies-GStreamer Linux / Windows VM)            |  |
|  |                                                                                                         |  |
|  |  +---------------------------------------------------------------------------------------------------+  |  |
|  |  |  ZERO-COPY SCREEN CAPTURE & AUDIO PIPELINE                                                        |  |  |
|  |  |  - Desktop Duplication API (DXGI / DDA) on Windows / PipeWire DMA-BUF on Linux Wayland/X11          |  |  |
|  |  |  - Audio Capture: PulseAudio / PipeWire Loopback -> Opus Encoder (32-128 kbps, 5ms frames)        |  |  |
|  |  +---------------------------------------------------------------------------------------------------+  |  |
|  |                                                  |                                                         |  |
|  |  +-----------------------------------------------v---------------------------------------------------+  |  |
|  |  |  HARDWARE VIDEO ENCODING ENGINE (NVENC / VA-API / Intel QuickSync / AMD AMF)                      |  |  |
|  |  |  - AV1 / SVT-AV1 Real-Time & H.264 (High 4:4:4 YUV444) Encoder                                    |  |  |
|  |  |  - Ultra-Low Latency Mode (Zero B-Frames, CBR/VBR, Dynamic Intra-Refresh, Rate-Control Feedback)   |  |  |
|  |  +---------------------------------------------------------------------------------------------------+  |  |
|  |                                                  |                                                         |  |
|  |  +-----------------------------------------------v---------------------------------------------------+  |  |
|  |  |  SELKIES-GSTREAMER WEBRTC MEDIA SERVER & EMULATED DEVICE HANDLER                                  |  |  |
|  |  |  - Selkies GStreamer WebRTC Media Engine (gstwebrtc, NVMM / EGL pipelines)                         |  |  |
|  |  |  - USB/IP Server (vhci-hcd kernel driver bridge) for Peripheral Forwarding                        |  |  |
|  |  |  - uinput / SendInput Kernel Virtual Input Driver (Mouse, Keyboard, Touch, Gamepad)              |  |  |
|  |  +---------------------------------------------------------------------------------------------------+  |  |
|  +---------------------------------------------------------------------------------------------------------+  |
+---------------------------------------------------------------------------------------------------------------+
```

### 7.1 Limitations of Legacy Apache Guacamole & Evolution Rationale

Standard Apache Guacamole architectures rely on `guacd` translating RDP/VNC protocols into the Guacamole protocol, transmitted over HTTP/WebSocket to a Java servlet (Tomcat) and rendered inside an HTML5 `<canvas>` element. While functional for basic administrative tasks, this legacy design exhibits severe bottlenecks:

| Dimension | Legacy Apache Guacamole | NeroNet Sovereign Remote Desktop (v5.0 Selkies-GStreamer) |
|---|---|---|
| **Transport Protocol** | TCP WebSocket (Head-of-line blocking, latency spikes on packet loss) | UDP WebRTC (SRTP/SCTP) over WireGuard mesh overlay (No HoL blocking) |
| **Video Delivery** | Software tile encoding (PNG/JPEG/WebP diffs) causing heavy CPU load | Zero-copy GPU HW encoding (H.264 / AV1 via NVENC, VA-API, AMF, QuickSync) |
| **Latency** | 120ms - 350ms (Unsuitable for CAD, video editing, gaming, IDEs) | **<30ms glass-to-glass round-trip** over mesh overlay |
| **Frame Rate & Resolution**| 15 - 30 FPS at 1080p, severe tearing on dynamic scenes | **60 - 120 FPS at 4K (3840x2160)** with dynamic intra-refresh |
| **Color Fidelity** | 4:2:0 subsampled with text color bleeding | **4:4:4 Full RGB / YUV444** crisp IDE font rendering |
| **Audio Fidelity** | 1-way basic PCM/WAV/MP3 over WebSocket, high latency, no AEC | 2-way full-band **Opus (48kHz stereo)**, dynamic bitrate, integrated AEC/AGC |
| **Client Experience** | Web browser tab (lacks multi-monitor, loses OS key combos) | **Native Tauri 2.0 desktop app** (OS shortcut grab, native multi-monitor, USB/IP) |
| **Peripherals & USB** | Basic virtual file drive, limited clipboard | True **USB/IP redirection** (YubiKeys, webcams, smartcards, audio DACs) |

---

### 7.2 Selkies-GStreamer WebRTC Audio/Video Streaming Engine Architecture

The streaming engine is built on the **Selkies-GStreamer** (https://github.com/selkies-project/selkies-gstreamer) framework, decoupling rendering from network transmission by embedding a native WebRTC peer endpoint inside the Cloud PC host instance. Selkies-GStreamer provides Linux containerized and VM desktop streaming with direct GPU access (NVIDIA CUDA / EGL / DRM), low-latency WebRTC data channels for mouse/keyboard inputs, and native audio loopback streaming.

#### Video Codec Specifications
1. **AV1 (AOMedia Video 1)**:
   - **Profile**: Main Profile (8-bit and 10-bit 4:2:0 and 4:4:4).
   - **Encoders**: NVIDIA NVENC (Ada Lovelace RTX 40-series / RTX 6000 Ada), Intel QuickSync (Arc / Meteor Lake), AMD AMF (RDNA3), and SVT-AV1 (CPU fallback with real-time preset `preset=10`, `tune=0`).
   - **Advantage**: Delivers 35-45% higher compression efficiency than H.264 at equivalent VMAF scores, preserving crystal-clear subpixel text antialiasing and high-contrast IDE fonts.
2. **H.264 / AVC (Advanced Video Coding)**:
   - **Profile**: High Profile / High 4:4:4 Predictive Profile (YUV444 for perfect text chroma without 4:2:0 color bleeding).
   - **Encoders**: Hardware NVENC, VA-API (`i965` / `iHD`), Apple VideoToolbox, and AMD AMF.
   - **Low-Latency Configuration**: Zero B-frames (`bf=0`), `zerolatency` tuning, single-frame VBV buffer (`vbv-maxrate = vbv-bufsize`), Slice-based multithreading, and Periodic Intra-Refresh (PIR) to eliminate keyframe network bursts.

#### Audio Codec Specifications
1. **Opus Codec**:
   - **Sample Rate**: 48 kHz (Full-band).
   - **Channels**: Dual-channel stereo (audio output) + Mono/Stereo (microphone input).
   - **Bitrate**: Dynamic adaptation between 32 kbps (speech) and 128 kbps (high-fidelity multimedia / music production).
   - **Frame Duration**: 5ms to 10ms packetization interval to minimize algorithmic latency.
   - **Resilience**: In-band Forward Error Correction (FEC) and Packet Loss Concealment (PLC).
2. **WebRTC Audio Processing Module (APM)**:
   - **Acoustic Echo Cancellation (AEC3)**: Prevents speaker output from echoing back into microphone streams during video conferences.
   - **Automatic Gain Control (AGC2)**: Normalizes input levels dynamically.
   - **RNNoise AI Noise Suppression**: Deep neural network filter eliminating mechanical keyboard clicks, PC fans, and ambient noise.

---

### 7.3 Zero-Copy Frame Grabbing & Hardware Video Encoding Pipeline

To achieve sub-30ms glass-to-glass latency, frame transmission eliminates CPU memory copies entirely through GPU Direct Memory Access (DMA) buffers:

```
[ GPU Framebuffer / Desktop Display ]
                |
                v  (Zero-Copy DXGI Desktop Duplication API / Linux DMA-BUF)
[ GPU Memory Texture (ID3D11Texture2D / EGLImage) ]
                |
                v  (Direct GPU Memory Pointer Passing)
[ Hardware Video Encoder (NVENC / VA-API / AMF / QuickSync) ]
                |
                v  (Encoded NAL Units / OBU Packets)
[ WebRTC RTP Packetizer (SRTP over UDP WireGuard VIP) ]
```

1. **Windows Host Pipeline**:
   - Utilizes DirectX Graphics Infrastructure (DXGI) Desktop Duplication API (`IDXGIOutputDuplication`).
   - Captures frame surfaces directly into DirectX 11 textures (`ID3D11Texture2D`).
   - Passes the `ID3D11Texture2D` shared resource handle directly into the NVENC `NV_ENC_REGISTER_RESOURCE` / Intel QuickSync D3D11 surface without downloading to system RAM.
2. **Linux Host Pipeline**:
   - Utilizes PipeWire and Wayland `xdg-desktop-portal` (`org.freedesktop.portal.ScreenCast`).
   - Allocates `DMA-BUF` file descriptors shared between the Wayland compositor (Mutter/KWin/Sway) and the hardware encoder via VA-API / NVENC CUDA IPC.

---

### 7.4 Ultra-Low Latency Transport & Adaptive Congestion Control (<30ms over WireGuard Mesh)

The media transport operates over NeroNet's userspace WireGuard mesh overlay using WebRTC over direct UDP peer-to-peer connections:

1. **Congestion Control & Rate Adaptation**:
   - Utilizes **Google Congestion Control (GCC)** combined with **SCReAM (Self-Clocked Rate Adaptation for Multimedia)**.
   - Real-time feedback via **RTCP Transport-CC (Transport-wide Congestion Control)** packets sent every 10ms.
   - Dynamic bitrate adjustment:
     $$\text{Bitrate}_{\text{target}}(t) = \min\left(\text{Bitrate}_{\text{GCC}}(t), \text{Throughput}_{\text{WireGuard}}(t)\right)$$
   - Quantization Parameter (QP) dynamically ramps between 18 (visually lossless) and 38 (lossy fallback) to maintain target frame rates without packet buffering.
2. **Jitter & Network Buffering**:
   - NetEQ adaptive playout buffer targets a playout delay of $d_{\text{playout}} \le 8\text{ms}$.
   - Forward Error Correction (ULPFEC / FlexFEC) dynamically scales FEC redundant packets (0% to 20%) based on real-time packet loss gradients, avoiding TCP retransmission delays.

---

### 7.5 Native Desktop Client Architecture (Tauri 2.0 Rust Core vs. Electron Benchmark)

To deliver a truly native desktop experience on Windows and macOS, the client framework must minimize memory overhead, provide low-level OS API access, and integrate seamlessly with GPU video decoders:

#### Framework Comparison Matrix

| Architectural Dimension | Electron (Chromium + Node.js) | Tauri 2.0 (Rust Core + OS WebView / WRY) | NeroNet Selection Rationale |
|---|---|---|---|
| **Binary Footprint** | 120MB - 180MB (Includes entire Chromium build) | **8MB - 18MB** (Lightweight Rust binary) | **Tauri 2.0**: Ultra-compact, fast cold start |
| **Idle Memory Footprint** | 180MB - 350MB RAM across 4+ processes | **30MB - 60MB RAM** (Native OS WebView) | **Tauri 2.0**: Minimal resource footprint |
| **Direct Hardware Access**| Requires complex C++ Node-API native addons | **Native Rust FFI / Windows Win32 API / macOS Cocoa** | **Tauri 2.0**: Direct low-level OS hooks |
| **Video Decoding** | Chromium internal video element | Hardware-accelerated native window surface | **Tauri 2.0**: Direct D3D11 / Metal rendering |
| **Security Sandbox** | Large Chromium attack surface | Hardened Rust memory safety + capabilities model | **Tauri 2.0**: Zero-Trust security compliance |

#### Tauri 2.0 Native Client Component Architecture
```
+-----------------------------------------------------------------------------------+
|                         NERONET DESKTOP CLIENT (TAURI 2.0)                        |
+-----------------------------------------------------------------------------------+
|  [ Frontend UI: Svelte 5 / React 19 + Tailwind CSS in Sandboxed Webview ]          |
|  - Multi-Monitor Topology HUD, Latency Graph, Connection Quality Status           |
+-----------------------------------------------------------------------------------+
                                         |
                                (Tauri IPC Bridge)
                                         |
+----------------------------------------v------------------------------------------+
|                     TAURI RUST CORE DAEMON (Native Backend)                       |
|  +-----------------------------------------------------------------------------+  |
|  |  libdatachannel / Pion WebRTC Media Client                                  |  |
|  |  - HW Accelerated Video Decoder (DirectX 11 / Metal / VA-API)                |  |
|  |  - High-Fidelity Audio Renderer (CPAL / CoreAudio / WASAPI)                  |  |
|  +-----------------------------------------------------------------------------+  |
|  |  OS Low-Level Hook Engine (Win32 WH_KEYBOARD_LL / macOS CGEventTap)         |  |
|  +-----------------------------------------------------------------------------+  |
|  |  Multi-Monitor Dynamic Viewport Manager (EnumDisplayMonitors / NSScreen)    |  |
|  +-----------------------------------------------------------------------------+  |
|  |  USB/IP Client Subsystem (WinUSB / IOKit Driver Bridge)                     |  |
|  +-----------------------------------------------------------------------------+  |
|  |  Bidirectional Clipboard & Virtual Channel File Transfer Engine            |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

---

### 7.6 Native Multi-Monitor Management & Dynamic DPI Virtual Topology

1. **Display Enumeration**:
   - **Windows**: Uses `EnumDisplayMonitors` and `GetDpiForMonitor` to query physical screen bounding rectangles, refresh rates, and DPI scaling factors.
   - **macOS**: Uses `[NSScreen screens]` and `CGDisplayBounds` / `CGDisplayModeGetRefreshRate`.
2. **Dynamic Topology Mapping**:
   - The client transmits the physical monitor configuration (e.g., Dual 4K displays: Monitor 1 at $(0,0, 3840, 2160)$, Monitor 2 at $(3840, 0, 3840, 2160)$) to the remote host via an SCTP control channel.
   - The remote Linux host utilizes a virtual DRM/KMS device (`vkms` / `evdi`) or Windows Virtual Display Driver (IddCx - Indirect Display Driver) to spawn matching virtual monitors on-the-fly.
   - Supports **spanning mode** (one virtual canvas stretched across displays) or **multi-window mode** (independent native windows docked to each physical monitor with separate WebRTC video streams).

---

### 7.7 Low-Latency USB & Peripheral Redirection (USB/IP over WireGuard)

1. **Architecture**: Implements the **USB/IP** (USB over IP) protocol encapsulated within an encrypted WireGuard mesh tunnel.
2. **Client Side (USB/IP Exporter)**:
   - Interacts with local USB devices via `libusb` / WinUSB driver.
   - Allows selective forwarding of:
     * **FIDO2 / U2F Security Keys (YubiKeys)** for hardware MFA inside the remote session.
     * **Audio DACs and Studio Microphones**.
     * **Webcams** (transcoded or raw UVC passthrough).
     * **Game controllers and flight sticks** (raw HID reports).
3. **Host Side (USB/IP Importer)**:
   - **Linux**: Attaches forwarded devices via the `vhci-hcd` (Virtual Host Controller Interface) kernel module.
   - **Windows**: Utilizes an open-source virtual USB bus driver (`UsbIP-Win2`).

---

### 7.8 Bidirectional Clipboard & Drag-and-Drop File Streaming Engine

1. **Text & Rich Content**: Synchronizes plain text (UTF-8), formatted text (HTML/RTF), and raster images (PNG/BMP) across client and host clipboards using local OS clipboard events (`WM_CLIPBOARDUPDATE` on Windows, `NSPasteboard` change count polling on macOS).
2. **Drag-and-Drop File Streaming**:
   - Dragging a file into the client window initiates a chunked binary stream over an encrypted WebRTC SCTP DataChannel.
   - File chunks (64KB blocks) are accompanied by a BLAKE3 integrity checksum and progress indicators.
   - Files are materialized directly into the remote user's `Downloads` directory or active desktop folder.

---

### 7.9 Native OS Keyboard & System Shortcut Interception

1. **Problem**: In a standard web browser, critical system shortcuts (`Alt+Tab`, `Win/Super`, `Ctrl+Alt+Del`, `Cmd+Tab`, `Cmd+Space`, `Ctrl+Shift+Esc`) are intercepted by the client OS and never reach the remote session.
2. **Windows Implementation**:
   - Installs a low-level keyboard hook via `SetWindowsHookExW(WH_KEYBOARD_LL, LowLevelKeyboardProc, hInstance, 0)`.
   - Captures `VK_LWIN`, `VK_RWIN`, `VK_TAB` (when Alt is held), and `VK_ESCAPE`.
   - Suppresses local execution (`return 1`) when the NeroNet window has focus, and transmits raw virtual key codes and scan codes directly over the low-latency SCTP control channel.
   - Dedicated CAD button or `Ctrl+Alt+End` translation for secure `Ctrl+Alt+Del` SAS (Secure Attention Sequence) injection on the host.
3. **macOS Implementation**:
   - Utilizes `CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, ...)` requiring Accessibility permissions.
   - Intercepts `kCGEventKeyDown` and `kCGEventFlagsChanged`, capturing `Cmd+Tab`, `Cmd+Q`, `Cmd+H`, and Mission Control shortcuts when the remote desktop window is active.

---

## 8. Zero-Knowledge Cryptographic Data Plane: End-to-End Encryption (E2EE) Architecture

NeroNet mandates an uncompromising **Zero-Knowledge Encryption** architecture across all hosted cloud data services (**Nextcloud**, **Vaultwarden / secrets vaulting**, and **Immich**). The cloud server and infrastructure operators retain strictly zero plaintext knowledge of stored user data.

```
+---------------------------------------------------------------------------------------------------------------+
|                      NERONET ZERO-KNOWLEDGE END-TO-END ENCRYPTION (E2EE) ARCHITECTURE                         |
+---------------------------------------------------------------------------------------------------------------+
|                                                                                                               |
|  +---------------------------------------------------------------------------------------------------------+  |
|  |                     NERONET CLIENT HARDWARE SECURE ENCLAVE / CRYPTO ENGINE                              |  |
|  |                                                                                                         |  |
|  |  +---------------------------------------------------------------------------------------------------+  |  |
|  |  |  MASTER KEY DERIVATION (Argon2id KDF: m=64MB, t=3, p=4)                                           |  |  |
|  |  |  User Master Passphrase + Hardware Salt  --->  Client Master Key (CMK: 256-bit)                    |  |  |
|  |  +---------------------------------------------------------------------------------------------------+  |  |
|  |                                                  |                                                         |  |
|  |  +-----------------------------------------------v---------------------------------------------------+  |  |
|  |  |  SERVICE-SPECIFIC KEY HIERARCHY (HKDF-SHA256 Expansion)                                           |  |  |
|  |  |  - K_nextcloud = HKDF-Expand(CMK, "neronet:nextcloud:v1", 32)                                      |  |  |
|  |  |  - K_vault     = HKDF-Expand(CMK, "neronet:vault:v1", 32)                                          |  |  |
|  |  |  - K_immich    = HKDF-Expand(CMK, "neronet:immich:v1", 32)                                         |  |  |
|  |  |  - (Identity_priv, Identity_pub) = Ed25519 / Curve25519 Keypair                                    |  |  |
|  |  +---------------------------------------------------------------------------------------------------+  |  |
|  |                                                  |                                                         |  |
|  |  +-----------------------------------------------v---------------------------------------------------+  |  |
|  |  |  CLIENT-SIDE DATA TRANSFORMS & EDGE PROCESSING                                                    |  |  |
|  |  |  - File/Media Chunking (4MB blocks) + AES-256-GCM / XChaCha20-Poly1305 Encryption                 |  |  |
|  |  |  - Metadata Encryption (File names, EXIF, tags, directory hierarchy)                             |  |  |
|  |  |  - Local On-Device Edge ML Vector Indexing (CLIP / Face Embedding on Apple NPU / Mobile GPU)      |  |  |
|  |  |  - Peer-to-Peer Sharing via Signal Double Ratchet Protocol (Curve25519 DH Ratchet + KDF Ratchet)   |  |  |
|  |  |  - Disaster Recovery: Shamir's Secret Sharing (SSS (3, 5) Threshold Polynomial Splits)           |  |  |
|  |  +---------------------------------------------------------------------------------------------------+  |  |
|  +---------------------------------------------------------------------------------------------------------+  |
|                                                     |                                                         |
|                     (HTTPS / gRPC / Mesh Overlay: Encrypted Blobs + Ciphertext Metadata Only)                 |
|                                                     |                                                         |
|  +--------------------------------------------------v------------------------------------------------------+  |
|  |                     NERONET HOSTED CLOUD SERVER / STORAGE BACKEND (Zero-Knowledge)                      |  |
|  |                                                                                                         |  |
|  |  +---------------------------------------------------------------------------------------------------+  |  |
|  |  |  BLIND STORAGE & CIPHERTEXT METADATA DATABASE                                                     |  |  |
|  |  |  - Object Storage: Opaque Encrypted Chunks (`uuid_04f8.blob`, `uuid_8b12.blob`)                   |  |  |
|  |  |  - Database: Encrypted JSON Payloads, Blind HMAC Indexes (`HMAC-SHA256(K_blind, Token)`)           |  |  |
|  |  |  - Nextcloud: E2EE Encrypted File Envelopes (No server-side file preview or index)                |  |  |
|  |  |  - Vaultwarden: AES-256 Encrypted Cipher Store (Server validates auth hash only)                   |  |  |
|  |  |  - Immich: Encrypted Photo Chunks & Encrypted Vector Blobs (No plaintext EXIF or thumbnails)      |  |  |
|  |  |  - Zero Telemetry: Absolute absence of server analytics, plain search queries, or user logs       |  |  |
|  |  +---------------------------------------------------------------------------------------------------+  |  |
|  +---------------------------------------------------------------------------------------------------------+  |
+---------------------------------------------------------------------------------------------------------------+
```

### 8.1 Zero-Knowledge Threat Model & Cryptographic Invariants

#### Threat Model
The Zero-Knowledge model operates under the **Honest-but-Curious and Malicious Server Threat Model**:
1. **Server Compromise / Subpoena / Physical Seizure**: If an adversary gains full `root` access to NeroNet's cloud servers, physical NVMe drives, RAM snapshots, or database dumps, they obtain **zero plaintext user data**.
2. **Untrusted Operators & Insiders**: Cloud administrators and infrastructure operators possess zero technical capability to decrypt files, view passwords, inspect photos, or decipher user queries.
3. **Man-in-the-Middle (MitM) Resistance**: All communications are encrypted end-to-end; even if TLS is terminated at a reverse proxy, the inner payloads remain cryptographically sealed by client-generated keys.

#### Core Cryptographic Invariants
1. **Plaintext Isolation**: Plaintext data and decryption keys **never** cross the boundary from the client device to the network or server.
2. **KDF Hardening**: All master encryption keys are derived using memory-hard KDF (**Argon2id**), rendering brute-force attacks computationally infeasible.
3. **Authenticated Encryption**: All ciphertext uses AEAD (Authenticated Encryption with Associated Data) ciphers (**AES-256-GCM** or **XChaCha20-Poly1305**), guaranteeing both confidentiality and ciphertext integrity.
4. **Zero Server Knowledge of Passwords**: The server receives only a one-way authentication proof hash (`AuthHash`), which cannot be inverted to derive the master encryption key (`MasterKey`).

---

### 8.2 Client Master Key (CMK) Derivation & Service Key Hierarchy

```
[ User Master Passphrase ] + [ Salt ]
                |
                v  (Argon2id KDF: m=64MB, t=3, p=4)
   [ Client Master Key (CMK: 256-bit) ]
                |
                +-----------------------+-----------------------+-----------------------+
                |                       |                       |                       |
                v                       v                       v                       v
        (HKDF-Expand)           (HKDF-Expand)           (HKDF-Expand)           (Ed25519 Gen)
      "nextcloud:root:v1"       "vault:root:v1"         "immich:root:v1"        "identity:v1"
                |                       |                       |                       |
                v                       v                       v                       v
      [ Nextcloud Root Key ]   [ Vaultwarden Master ]  [ Immich Media Master ]  [ Device Identity KP ]
```

1. **Client Master Key (CMK) Derivation**:
   - Master keys are derived client-side via memory-hard Argon2id:
     $$\text{CMK} = \text{Argon2id}(\text{Passphrase}, \text{Salt}_{\text{device}}, \text{iterations}=3, \text{memory}=64\text{MB}, \text{parallelism}=4, \text{keylen}=32)$$
2. **Service Key Hierarchy Expansion**:
   - Sub-keys for individual services are derived deterministically via HKDF-Expand (RFC 5869):
     * $K_{\text{nextcloud}} = \text{HKDF-Expand}(\text{CMK}, \text{"neronet:nextcloud:v1"}, 32)$
     * $K_{\text{vault}} = \text{HKDF-Expand}(\text{CMK}, \text{"neronet:vault:v1"}, 32)$
     * $K_{\text{immich}} = \text{HKDF-Expand}(\text{CMK}, \text{"neronet:immich:v1"}, 32)$
     * $K_{\text{blind}} = \text{HKDF-Expand}(\text{CMK}, \text{"neronet:blind-index:v1"}, 32)$

---

### 8.3 Nextcloud Sovereign E2EE Architecture

Nextcloud integration enforces the native Nextcloud **End-to-End Encryption (E2EE)** module standard with hardened client key derivation:

```
(Per-Folder Symmetric Key Generation)
[ Folder Key (AES-256-GCM) ]  ---> Encrypted via Curve25519 ECIES Envelope
                |
                v
[ File Chunks (4MB) Encrypted with AES-256-GCM ]
[ Nonce_i = 96-bit (FileUUID || ChunkIndex)   ]
                |
                v
[ Uploaded as Opaque UUID Blobs to Nextcloud Storage Backend ]
```

1. **Client-Side Folder Initialization**:
   - For an E2EE-designated directory, the client generates a cryptographically random 256-bit `FolderKey`.
   - The `FolderKey` is encrypted (wrapped) with the public keys of all authorized users using ECIES (Elliptic Curve Integrated Encryption Scheme with Curve25519 + HKDF-SHA256 + AES-256-GCM).
2. **File Chunking & Encryption**:
   - Files are split into 4MB chunks.
   - Each chunk is encrypted using AES-256-GCM:
     $$C_i = \text{AES-256-GCM-Encrypt}(K_{\text{file}}, \text{Nonce}_i, \text{Chunk}_i, \text{AAD})$$
   - $\text{AAD}$ (Additional Authenticated Data) binds the chunk index, file UUID, and folder UUID to prevent chunk swapping or tampering.
3. **Metadata & Filename Obfuscation**:
   - File names, sizes, MIME types, and folder trees are serialized into a JSON metadata payload, encrypted with the `FolderKey`, and uploaded. The server storage volume contains only opaque filenames (e.g., `4a8f9c12-3b4e-4f11-9a72-881c04d1ef9a.blob`).

---

### 8.4 Vaultwarden / Secrets Engine Integration Architecture

To provide enterprise-grade secret and credential storage without server-side knowledge, NeroNet leverages the Bitwarden-compatible zero-knowledge cryptographic protocol:

1. **Key Derivation Flow**:
   - Inputs: User Email ($E$) and Master Password ($P$).
   - Salt generation: $\text{Salt} = \text{HKDF-Extract}(\text{Salt}_{\text{global}}, \text{LowerCase}(E))$.
   - Master Key Derivation:
     $$\text{MasterKey} = \text{Argon2id}(P, \text{Salt}, \text{iterations}=3, \text{memory}=64\text{MB}, \text{parallelism}=4, \text{keylen}=32)$$
   - Master Password Hash (for Server Authentication):
     $$\text{PasswordHash} = \text{PBKDF2-HMAC-SHA256}(\text{MasterKey}, P, \text{iterations}=1, \text{keylen}=32)$$
   - Symmetric Encryption Key:
     $$\text{StretchedMasterKey} = \text{HKDF-Expand}(\text{MasterKey}, \text{"enc"}, 32)$$
2. **Data Vault Item Encryption**:
   - Each secret cipher (username, password, secure notes, TOTP seed) is encrypted client-side:
     $$\text{Ciphertext} = \text{AES-256-GCM-Encrypt}(\text{StretchedMasterKey}, \text{IV}_{96}, \text{PlaintextJSON})$$
   - The encrypted payload is transmitted to Vaultwarden as:
     `{"Type": 1, "IV": "<base64>", "Data": "<base64>", "Mac": "<base64_auth_tag>"}`
3. **Zero Knowledge Proof**:
   - The server only ever validates $\text{PasswordHash}$ against its stored bcrypt/Argon2 hash for login.
   - The server **never** sees $\text{MasterKey}$ or $\text{StretchedMasterKey}$. If the Vaultwarden SQLite/PostgreSQL database is compromised, all stored ciphers remain undecipherable AES-256-GCM ciphertext.

---

### 8.5 Immich Sovereign Photo & Video Vault Architecture (Chunk Encryption & Edge ML)

Integrating Zero-Knowledge E2EE into media galleries presents unique technical challenges regarding thumbnails, video streaming, and AI-driven search (facial recognition, object classification, semantic search). NeroNet implements an innovative hybrid on-device edge ML architecture:

```
[ Photo / Video File (RAW / HEIC / MP4) ]
                |
                +---------------------------------------+
                |                                       |
  (Local Client Edge Machine Learning)                  | (Client-Side Chunk Encryption)
                |                                       |
  [ Apple Neural Engine / Mobile GPU NPU ]              v
  - Facial Feature Vectors (512-d embeddings)    [ Chunk 1 (4MB) ] [ Chunk 2 (4MB) ]
  - CLIP Semantic Vectors (768-d embeddings)            |                 |
  - EXIF Metadata Stripping & JSON Envelope             v (AES-256-GCM)   v (AES-256-GCM)
                |                                [ Ciphertext 1 ]  [ Ciphertext 2 ]
                v (AES-256-GCM Encrypted)               |                 |
  [ Encrypted Vector & Metadata Blob ]                  +--------+--------+
                |                                                |
                +------------------------------------------------+
                                       |
                                       v
         [ Upload to Immich Storage Backend: Opaque Encrypted Chunks ]
```

1. **Client-Side Chunk Encryption & Transcoding**:
   - High-resolution media files and 4K videos are chunked into 4MB blocks.
   - Each media item is assigned a cryptographically random `MediaKey` (256-bit).
   - Video chunks are encrypted using AES-256-GCM with counter-based nonces, enabling byte-range seeking and on-the-fly decryption during playback in the NeroNet native client.
   - Thumbnails (micro and preview sizes) are generated locally on the client, encrypted with the `MediaKey`, and uploaded as encrypted preview blobs.
2. **Local Edge Machine Learning vs. Confidential Enclaves**:
   - **Primary Mode (On-Device Edge ML Indexing)**:
     * Facial recognition (MobileFaceNet / InsightFace) and semantic search (CLIP ViT-B/32) models run locally on the user's client hardware (leveraging Apple CoreML / Neural Engine on iOS/macOS, NNAPI on Android, and DirectML/ONNX Runtime on Windows).
     * Feature vectors (embeddings) are generated locally on the client and stored in a local SQLite-Vec database.
     * An encrypted copy of the vector database is synchronized to the cloud for backup.
     * When the user searches ("sunset at the beach" or "photos of Alice"), the query vector is computed and matched locally with 0 server-side computation or data disclosure.
   - **Confidential Computing Enclave Mode (Optional for Low-Powered Clients)**:
     * For thin clients lacking local NPU acceleration, NeroNet provides an optional hardware-encrypted enclave execution mode on **AMD SEV-SNP (Secure Encrypted Virtualization-Secure Nested Paging)** or **Intel SGX**.
     * The client negotiates an RA-TLS (Remote Attestation TLS) session directly into the hardware CPU enclave.
     * Decryption and vector processing occur exclusively inside the CPU enclave's hardware-encrypted RAM; cloud hypervisors and host OS kernels cannot inspect the enclave memory.

---

### 8.6 Client-Side Key Exchange & Sharing Protocols (Signal Double Ratchet & X3DH)

When sharing encrypted files, photo albums, or password vaults between multiple NeroNet users, the system utilizes the **Signal Double Ratchet Protocol** combined with **Extended Triple Diffie-Hellman (X3DH)** over Curve25519 / Ed25519:

```
+-----------------------------------------------------------------------------------+
|                        SIGNAL DOUBLE RATCHET KEY EXCHANGE FLOW                    |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|     ALICE (Sender)                                              BOB (Recipient)   |
|     --------------                                              ---------------   |
|                                                                                   |
|     [ Generate Ephemeral DH: E_A ]                              [ Published Prekey: |
|                                                                 IK_B, SPK_B, OPK_B]|
|                                                                                   |
|     1. Perform X3DH Agreement:                                                    |
|        DH1 = X25519(IK_A, SPK_B)                                                  |
|        DH2 = X25519(E_A, IK_B)                                                    |
|        DH3 = X25519(E_A, SPK_B)                                                   |
|        DH4 = X25519(E_A, OPK_B)                                                   |
|        Master Shared Secret (SK) = KDF(DH1 || DH2 || DH3 || DH4)                  |
|                                                                                   |
|     2. Initialize Double Ratchet:                                                 |
|        - Root KDF Chain (Advances with each DH ratchet exchange)                  |
|        - Symmetric Sending/Receiving Chains (Advances with each message/item key) |
|                                                                                   |
|     3. Forward Secrecy & Break-in Recovery:                                       |
|        - Compromising current key K_i does not reveal past keys K_{i-1}           |
|        - New DH ratchet step immediately restores secrecy if device is cleansed   |
+-----------------------------------------------------------------------------------+
```

#### Protocol Steps for Secure Resource Sharing:
1. **Identity & Prekeys**:
   - Each NeroNet user publishes an Identity Key (`IK`), Signed Prekey (`SPK`), and pool of One-Time Prekeys (`OPK`) signed with their Ed25519 long-term identity key.
2. **Session Initialization (X3DH)**:
   - Alice performs an X3DH key agreement with Bob's prekeys to establish a mutual shared secret `SK`.
3. **Double Ratchet Operation**:
   - The Root KDF advances whenever an asymmetric ratchet step (new Curve25519 ephemeral key) occurs.
   - The Symmetric KDF chain derives unique single-use message keys for each shared resource envelope (`EncryptedResourceKey`).
   - Guarantees **Forward Secrecy** (past shared resources cannot be decrypted if an active key is exposed) and **Post-Compromise Security** (healing the cryptographic session on the next DH ratchet exchange).

---

### 8.7 Disaster Recovery via Shamir's Secret Sharing (SSS $(3, 5)$ Threshold Scheme)

To eliminate single points of failure without introducing a server-side backdoor or master recovery key, NeroNet implements a $(K, N) = (3, 5)$ **Shamir's Secret Sharing (SSS)** scheme over Galois Field $GF(2^{256})$:

```
                       [ User Client Master Key (CMK: 256-bit) ]
                                       |
                 (Construct Polynomial: f(x) = CMK + a_1 x + a_2 x^2 mod p)
                                       |
        +----------------+-------------+---------------+----------------+
        |                |                             |                |
        v                v                             v                v
   [ Share 1 ]      [ Share 2 ]                   [ Share 3 ]      [ Share 4 ]      [ Share 5 ]
 (Trusted Peer)   (FIDO2 Hardware)              (Mnemonic Print) (Trusted Contact)(Cold Cloud Blob)
```

1. **Polynomial Construction**:
   - For a $(3, 5)$ threshold scheme, a random degree-2 polynomial is constructed:
     $$f(x) = \text{CMK} + a_1 x + a_2 x^2 \pmod{p}$$
     where $\text{CMK} = f(0)$ is the secret master key, $a_1, a_2 \in_R GF(2^{256})$, and $p = 2^{256} - 189$ (standard 256-bit prime field).
2. **Share Distribution**:
   - **Share 1 (Secondary Device)**: Stored securely on the user's secondary trusted device (e.g. iPad / Laptop Secure Enclave).
   - **Share 2 (FIDO2 Token)**: Sealed inside a hardware security key (FIDO2 / YubiKey HMAC-SHA256 secret extension).
   - **Share 3 (Paper Mnemonic)**: Encoded as a 24-word BIP-39 mnemonic recovery phrase for physical paper backup.
   - **Share 4 (Social Recovery)**: Encrypted and escrowed with a designated trusted contact via Double Ratchet.
   - **Share 5 (Cold Cloud Backup)**: Encrypted with a user-chosen secondary recovery passphrase and stored in NeroNet cold storage.
3. **Reconstruction**:
   - Presenting any $K=3$ of the 5 shares allows Lagrange interpolation to reconstruct the secret:
     $$\text{CMK} = f(0) = \sum_{j=1}^{3} y_j \prod_{m \ne j} \frac{-x_m}{x_j - x_m} \pmod{p}$$
   - Any $K-1=2$ shares provide mathematically zero information regarding $\text{CMK}$.

---

### 8.8 Encrypted-Blob-Only Storage Architecture & Blind HMAC Search Indexing

#### Server Storage Layout (Content-Addressable & Blind Indexing)
All server-side storage buckets and relational databases store strictly opaque ciphertext:

```
/var/lib/neronet/storage/
├── blobs/
│   ├── 0a/
│   │   └── 0a4f89b1c2e3d4f5.blob   <-- AES-256-GCM Encrypted Media/File Chunk
│   ├── 8f/
│   │   └── 8fb34d92e10a7c61.blob   <-- AES-256-GCM Encrypted Photo Chunk
│   └── c3/
│       └── c318a9ef45b20188.blob   <-- Encrypted Vector / Metadata Envelope
└── database.sqlite                 <-- Stores Blind HMAC Indexes & Encrypted JSON Payloads
```

#### Blind Search Indexing & Zero Operator Telemetry
1. **Blind Search Indexes**:
   - To query metadata (e.g. checking whether a file path exists) without leaking plaintext strings to the database:
     $$\text{BlindIndex} = \text{HMAC-SHA256}(K_{\text{blind}}, \text{Normalize}(\text{SearchTerm}))$$
   - The server matches hashes blindly without knowing what terms they represent.
2. **Zero Operator Telemetry Policy**:
   - Application web servers and API gateways operate with logging levels set to `ERROR` only.
   - Standard HTTP access logs (containing client IP addresses, User-Agents, and path queries) are directed to `/dev/null` or disabled entirely in Nginx/Envoy configs (`access_log off;`).
   - Diagnostic metrics collected by Prometheus are strictly aggregated network-level counters (bytes in/out, container CPU/RAM utilization) stripped of all tenant identifiers.

