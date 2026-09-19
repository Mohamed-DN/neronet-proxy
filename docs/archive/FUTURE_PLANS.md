> Historical document, not maintained. It is a version 5 wish list written before the current plan and does not describe the current code. For the current state read [the handbook](../HANDBOOK.md).

# Sovereign Proxy - Version 5.0 (Future Roadmap)

While v4.0 establishes the definitive Enterprise Proxy & Mesh Dashboard platform, v5.0 will focus on "Nation-State" level cyber-intelligence technologies.

## 1. Auto-Morphing Engine (DPI Evasion)
Currently, the system relies on static protocol selection (VLESS/WireGuard). In v5, the system will dynamically analyze packets and morph obfuscation protocols in milliseconds when authoritarian Deep Packet Inspection (DPI) is detected, without dropping the user's connection. 
**Crucial Architectural Constraint:** True AI/LLMs require GPUs, high latency, and high operational costs, and are prone to hallucinations. Therefore, this morphing engine will *not* use heavy GenAI. Instead, it will use **highly optimized local deterministic algorithms**, fast heuristics, eBPF/XDP traffic analysis, or lightweight local ML classifiers (e.g., Decision Trees) that can run efficiently on standard CPUs at the edge.

## 2. True P2P NAT Traversal (Zero-Cloud)
Transitioning from a central Relay architecture to a pure Zero-Trust P2P model. v5 will implement STUN/TURN protocols (similar to Tailscale/ZeroTier/NetBird) to allow edge clients (phones, laptops) to establish direct UDP hole-punching through NAT firewalls. This removes the cloud relay bottleneck entirely.

## 3. Post-Quantum Cryptography (PQC)
To defend against "Store Now, Decrypt Later" intelligence gathering, the current cryptographic suites will be upgraded or hybridized with quantum-resistant algorithms (e.g., CRYSTALS-Kyber or Kyber-Curve25519 hybrids) for establishing mesh tunnels.

## 4. Native OpenWrt Firmware Integration
Instead of relying solely on Docker containers for edge nodes, v5 will provide a native `.ipk` package flashable directly onto consumer home routers. This will allow any standard household router to become a silent "UFO / Exit Node" bridge in the Sovereign Mesh without requiring users to run PCs or servers.
