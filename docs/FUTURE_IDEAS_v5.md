# NeroNet Future Horizons (v5.x+ Backlog Ideas)

> **IMPORTANT**: This document contains research concepts and long-term architectural ideas for future major releases (v5.x+).  
> **These features are explicitly OUT OF SCOPE for the active delivery plan (Phases 1–6).** They must not delay or complicate current milestone execution.

---

## 1. eBPF / XDP Line-Rate Data Forwarding (100 Gbps Kernel Bypass)
* **Concept**: Shift the relay forwarding path directly into the network interface driver/kernel layer using eBPF (Extended Berkeley Packet Filter) and XDP (eXpress Data Path).
* **Target Audience**: Ultra-high-throughput telecommunication carriers, tier-1 cloud providers, and global relay backbones handling tens of millions of packets per second.
* **Why Deferred**: The current WireGuard kernel module and user-space TUN handle 1–10 Gbps with sub-millisecond latency, more than sufficient for thousands of concurrent nodes without requiring custom kernel drivers or specialized NIC hardware.

---

## 2. Multi-Controller P2P Federation (Inter-Mesh Peering)
* **Concept**: Allow two completely separate NeroNet sovereign control planes (e.g. Org A and Org B in different jurisdictions) to establish cryptographic bilateral peering trust without sharing a database or single point of authority (similar to BGP peering or Matrix federation).
* **Why Deferred**: Current focus is single-tenant and multi-tenant sovereign organizations managed under strict 3-node HA control plane consensus.

---

## 3. Hardware HSM & Cloud Enclave Sealing (TPM 2.0 / Nitro Enclaves / YubiHSM)
* **Concept**: Store and execute Root CA signing keys, audit HMAC seeds, and master decryption keys inside physical Hardware Security Modules (YubiHSM 2, dedicated PCIe HSM) or cryptographically isolated cloud CPU enclaves (AWS Nitro Enclaves, AMD SEV).
* **Why Deferred**: Current BIP-39 mnemonic seed + encrypted secrets table + PostgreSQL envelope encryption provides high enterprise security without requiring dedicated physical hardware.
