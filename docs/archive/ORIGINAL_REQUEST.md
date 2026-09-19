> Historical document, not maintained. It is the task statement of an earlier development phase and does not describe the current code. For the current state read [the handbook](../HANDBOOK.md).

# Original User Request

## 2026-08-27T03:44:22Z

Execute the final Open-Source Readiness cleanup for Sovereign Proxy v4.0 (NeroNet), design the auto-scaling architecture, and research/document the integration of bundled cloud services (Nextcloud, Immich, Seafile). Finally, push all changes to GitHub.

Use a very large team of agents.

Working directory: ~/teamwork_projects/sovereign_proxy_v4_retry
Integrity mode: development

## Requirements

### R1. Public Open-Source Readiness
Audit the entire repository for any hardcoded secrets, domain names, or environment-specific values. Extract all configuration into a single, centralized `.env.example` file and a clear configuration manager. Write a `DEVELOPER_SETUP.md` explaining how external developers can easily copy the template, insert their own keys/domains, and deploy the system.

### R2. Auto-Scaling Architecture
Update the deployment manifests and documentation to include blueprints for Auto-Scaling. Define aggressive auto-scaling configurations for Cloud nodes (OCI Instance Pools, AWS ASG) and bounded/limited auto-scaling for local nodes.

### R3. App Bundles Integration (Nextcloud, Immich, Seafile)
Research the source code and documentation of Nextcloud, Immich, and Seafile to understand their SSO (OIDC/SAML) and dynamic provisioning capabilities. Create a `BUSINESS_AND_ROADMAP.md` document that details how NeroNet will integrate these services as opt-in, paid add-ons. The design must include dynamic container provisioning per user and seamless Single Sign-On via the NeroNet client.

### R4. Final GitOps Push
Once the codebase is scrubbed for public release and the new roadmap documents are created, commit the changes and execute the GitOps push to the user's remote GitHub repository (`Mohamed-DN/sovereign-oci-proxy`) on the `main` branch.

## Acceptance Criteria

### Independent Agent Rubric (Verification)
- [ ] **Secret Sanitization:** An independent forensic agent must scan the repository using tools like `trufflehog` or `gitleaks` to verify 0 hardcoded secrets or environment variables exist in the committed code.
- [ ] **Developer Experience:** An independent agent must verify that the `.env.example` and `DEVELOPER_SETUP.md` provide a complete, unbroken path for a new developer to configure the system.
- [ ] **Bundle Architecture:** An independent agent must review `BUSINESS_AND_ROADMAP.md` to ensure the technical feasibility of the Nextcloud/Immich/Seafile SSO integration is accurately documented.
- [ ] **GitHub Push:** An independent agent must verify the changes were successfully pushed to `main`.

## Follow-up — 2026-08-27T07:58:48Z

Resume and complete Phase 8 (Open-Source Readiness) for Sovereign Proxy v4.0 (NeroNet). Sanitize the repository, document the auto-scaling and App Bundles roadmap, generate a master README with graphics, clean up all AI-generated internal files, and execute the final GitOps push.

Use a very large team of agents.

Working directory: ~/teamwork_projects/sovereign_proxy_v4_retry
Integrity mode: development

## Requirements

### R1. Public Open-Source Readiness
Audit the repository for hardcoded secrets or environment-specific values. Extract configuration into `.env.example`. Write `DEVELOPER_SETUP.md`.

### R2. Auto-Scaling Architecture
Update the deployment manifests and document aggressive auto-scaling configurations for Cloud nodes (OCI/AWS) and limited auto-scaling for local nodes in `docs/AUTOSCALING.md`.

### R3. App Bundles Integration (Nextcloud, Immich, Seafile)
Create `BUSINESS_AND_ROADMAP.md` detailing how NeroNet will integrate these services as opt-in, paid add-ons with dynamic container provisioning and SSO via the NeroNet client.

### R4. Master README & Architecture Graphic
Create a beautiful, comprehensive `README.md` for the root of the repository. It must explain what the project is, how to use it, and feature high-quality mermaid.js architecture diagrams representing the NeroNet mesh, auto-scaling, and client exit routing.

### R5. Repository Cleanup (Zero Agent Artifacts)
Before pushing, ensure absolutely NO useless internal AI files remain in the repository. Delete all `.agents/` directories, temporary prompt files, and internal logs. The repository must look like it was built exclusively by human engineers.

### R6. Final GitOps Push
Commit the sanitized, documented codebase and execute the GitOps push to `Mohamed-DN/sovereign-oci-proxy` on `main`.

## Acceptance Criteria

### Independent Agent Rubric (Verification)
- [ ] **Secret Sanitization:** Verify 0 hardcoded secrets or environment variables exist.
- [ ] **README Quality:** Verify the `README.md` contains clear instructions and at least one valid mermaid.js architectural graphic.
- [ ] **Cleanup Verification:** Verify directories like `.agents` do not exist in the final commit.
- [ ] **GitHub Push:** Verify the changes were successfully pushed to `main`.

## Follow-up — 2026-08-27T08:01:14Z

URGENT USER INSTRUCTION: Do NOT delete the `.agents/`, logs, or any internal AI prompt files from the local working directory (`~/teamwork_projects/sovereign_proxy_v4_retry`). The user wants to keep the AI context locally for future improvements. 
To satisfy R5 (Repository Cleanup for the public repo), you MUST clone/copy the repository to a staging directory (e.g., `~/teamwork_projects/sovereign_proxy_v4_staging_push`), perform the `.agents` and internal file cleanup ONLY in that staging directory, and execute the GitOps Push (R6) from that clean staging directory. Leave the original local directory completely intact with all its agent artifacts.

## Follow-up — 2026-08-27T08:19:02Z

URGENT USER INSTRUCTION: To ensure absolute security and prevent malicious actors from extracting hardcoded secrets from the Git commit history, you MUST wipe the repository history before executing the GitOps push. In your isolated staging directory, delete the `.git` folder, run `git init`, stage all sanitized files, create a single new clean commit, and execute a `git push --force origin main` to the remote repository. This ensures zero secrets exist in the project's entire history.

## Follow-up — 2026-08-27T08:49:12Z

Execute Phase 9 (Business Expansion & E2EE Roadmap) for Sovereign Proxy v4.0 (NeroNet). Update the `FUTURE_PLANS.md` and `BUSINESS_AND_ROADMAP.md` documents to integrate new premium homelab apps (Guacamole RDP, M-DNVault, SkillForge), define a strict Zero-Knowledge Encryption architecture, and design a Hybrid Data Residency model (Managed Cloud vs. Free Self-Hosted). Push the updated plans to GitHub.

Use a very large team of agents.

Working directory: ~/teamwork_projects/sovereign_proxy_v4_retry
Integrity mode: development

## Requirements

### R1. App Bundles Expansion
Analyze and integrate four new concepts into `BUSINESS_AND_ROADMAP.md` as premium/add-on modules:
1. **Sovereign Homelab Ecosystem**: A 1-click deployment of 31 unified services (CA, SSO, backups).
2. **Sovereign Guacamole RDP**: A "Cloud PC" offering.
3. **M-DNVault**: Enterprise password manager.
4. **SkillForge**: AI-powered career learning platform.
Document how these will be monetized, deployed, and seamlessly connected to the NeroNet mesh.

### R2. Advanced Remote Desktop (Native App & A/V)
In `FUTURE_PLANS.md`, architect the evolution of the Guacamole RDP service. It must support high-fidelity Audio/Video passthrough (e.g., leveraging WebRTC or optimized protocols) and be wrapped to feel exactly like a native Windows/macOS application, rather than just a web browser tab.

### R3. Zero-Knowledge Encryption (E2EE)
Update the architecture documents to mandate a strict Zero-Knowledge Encryption model for all hosted data (Nextcloud, Vault, Immich). If a NeroNet managed server is breached or seized, the attacker must only see encrypted blobs. Document the client-side encryption keys strategy.

### R4. Hybrid Data Residency (Cloud vs. BYOS)
Design a liability-reducing deployment model in the business plan. Users must have two options during checkout:
- **Managed Cloud (Paid):** Hosted on NeroNet servers (encrypted).
- **Self-Hosted / BYOS (Free core):** Users host the data on their own home servers, but still use NeroNet to securely access it. This absolves NeroNet of data liability.

### R5. Final GitOps Push
Stage the updated markdown documents, commit the changes in the staging directory (to avoid polluting git history with agent files), and push to `Mohamed-DN/sovereign-oci-proxy` on `main`.

## Acceptance Criteria

### Independent Agent Rubric (Verification)
- [ ] **Roadmap Quality:** Verify `BUSINESS_AND_ROADMAP.md` includes dedicated sections for the Homelab ecosystem, Password Manager, SkillForge, and the Hybrid Data Residency model.
- [ ] **RDP & E2EE Specs:** Verify `FUTURE_PLANS.md` includes the technical blueprint for WebRTC A/V passthrough for Guacamole and the Zero-Knowledge Encryption key exchange mechanism.
- [ ] **GitHub Push:** Verify the markdown updates were successfully pushed to `main`.

## Follow-up — 2026-08-27T08:50:57Z

URGENT USER INSTRUCTION: Course correction for R1 (App Bundles Expansion). Do NOT include `M-DNVault` or `SkillForge` as actual products, managed apps, or commercial offerings in the `BUSINESS_AND_ROADMAP.md` catalog. The user stated they are useless as actual product offerings for this VPN/Cloud business. Instead, only analyze their underlying *architectures* (e.g., event-driven Kubernetes patterns from SkillForge, security/credential patterns from M-DNVault) and integrate those *technical concepts* into NeroNet's core architectural plans if they are useful. The Guacamole RDP (Cloud PC) and general Homelab architecture concepts should still be planned.

## Follow-up — 2026-08-27T08:53:32Z

URGENT USER INSTRUCTION: Further course correction for R1. Do NOT include "Sovereign Homelab Ecosystem" as a commercial product bundle either. Like Vault and SkillForge, the Homelab repository should only be mined for its architectural ideas (e.g., Internal CAs, SSO integration, routing 30+ services securely) to improve NeroNet's core backend. 
HOWEVER, **Sovereign Guacamole RDP (Cloud PC)** IS fully approved as a commercial product offering. Continue planning the Guacamole RDP expansion (selling managed Windows/Linux instances with WebRTC A/V passthrough and native app wrappers). The Nextcloud/Immich/Seafile bundles from Phase 8 also remain as valid product offerings.

## Follow-up — 2026-08-31T07:39:48Z

Build the NeroNet Enterprise Management Console (Control Plane Web UI + API backend) and deploy it locally on the macOS staging environment. The system must command the entire NeroNet ecosystem and feature a premium, enterprise-grade UI design.

Use a very large team of agents.

Working directory: ~/teamwork_projects/sovereign_proxy_v4_retry/console
Integrity mode: development

## Requirements

### R1. Enterprise Frontend Web UI
Build a modern, dark-themed Enterprise Dashboard (using React, Vite, Tailwind CSS, or similar stack). It must include:
- **Global Overview:** Real-time stats (Active Nodes, Bandwidth, Connected Users).
- **User Management:** Create/Revoke users, assign them to Hybrid or Cloud hosting tiers.
- **Node Matrix:** View all connected devices and generate VPN/Noise cryptographic configs for new clients.
- **App Bundles:** A control panel to provision/manage "Cloud PC" (Guacamole) and Cloud Storage (Nextcloud/Immich) instances.

### R2. Control Plane API
Build a backend service (e.g., Go or Node.js) that exposes REST/GraphQL endpoints for the frontend. It should handle authentication (Super-Admin vs User Portal) and manage state (database interactions for users/nodes).

### R3. Safe Local Deployment (Staging)
Provide a completely automated startup mechanism (e.g., `docker-compose.yml` or a setup script) to run the Console and its Database on the local macOS machine (e.g., on ports 8443/8081). It must NOT interfere with existing global routing or Tailscale.

### R4. GitOps Push
Integrate the new `console/` codebase into the main repository. Stage the files without AI artifacts and push to `Mohamed-DN/sovereign-oci-proxy` on `main`.

## Acceptance Criteria

### Independent Agent Rubric (Verification)
- [ ] **UI/UX Audit:** An independent agent must verify the frontend compiles, renders without errors, and strictly adheres to an enterprise-grade dark UI/UX methodology (Tailwind/CSS).
- [ ] **API Health:** An independent agent must verify the backend API starts successfully and responds to a health-check endpoint (`/api/health`).
- [ ] **GitOps Verification:** The code must be cleanly pushed to the GitHub repository.

## Follow-up — 2026-08-31T07:50:00Z

URGENT USER INSTRUCTION: Enhance R1 (Enterprise Frontend Web UI) with the following specific capabilities:
1. **Interactive 3D Network Topology:** Instead of a simple list, integrate a 3D "spiderweb" graph visualization (e.g., using `react-force-graph-3d` or similar). Super-Admins should see the entire global mesh. Regular users must see ONLY their personal isolated mesh.
2. **Node Management Actions:** Clicking on a node in the 3D graph or list must expose actions: "Ping Device", "Set as Exit Node", and "Quarantine/Isolate" (tying into our posture checking system).
3. **P2P File Transfer (NeroDrop):** Add UI support for direct P2P file transfers between a user's own connected devices (similar to Taildrop).
Ensure these features are mocked/implemented in the React frontend and mapped to the backend API specs.

## Follow-up — 2026-08-31T08:55:23Z

URGENT USER INSTRUCTION: Inject two final features into the Management Console before pushing:
1. **Onion Obfuscation Toggle:** Add a UI switch in the Node Configuration page to easily enable/disable "3-Hop Onion Obfuscation" (since users need to trade-off between privacy and latency).
2. **Guacamole Public Share Links:** Add a feature in the "App Bundles / Cloud PC" section to generate secure, public internet links for Guacamole instances. These links must be accessible from outside the VPN (e.g., `https://workspace.neronet.darknero.com/...`) but heavily protected by the SSO/Auth gateway (or temporary passwords) to allow "Clientless RDP" from any browser on the internet securely.
Update the React frontend and the API specs to reflect these options.

## Follow-up — 2026-09-01T08:45:04Z

This is a single self-contained fix; keep it small and focused.
Fix the frontend data binding in Sovereign Proxy v4.0 (specifically `api.js`) so that the generated mock data (120 test nodes) correctly overrides the empty database response. Ensure the UI successfully renders these nodes on the 3D Topology, Geofencing Map, and Node Matrix to allow for stress-testing.

Working directory: ~/teamwork_projects/sovereign_proxy_v4_retry
Integrity mode: development

## Requirements

### R1. Fix Data Fallback Logic
Modify `console/frontend/src/services/api.js`. The current logic `let nodes = live?.nodes || inMemoryNodes;` evaluates to `[]` when the database returns an empty array. Update this so that if the returned array is empty (length 0), it correctly falls back to `inMemoryNodes` (which contains the 120 mock nodes).

### R2. Verify UI Components
Ensure that the 3D Topology, Geofencing Map, and Node Matrix properly receive the 120 nodes without crashing or throwing type errors. 

## Acceptance Criteria

### Automated Verification
- [ ] An independent agent can verify that `console/frontend/src/services/api.js` uses `inMemoryNodes` when the API returns an empty array.
- [ ] An independent agent can verify that running `npm run build` inside `console/frontend/` completes without errors, confirming syntax validity.


