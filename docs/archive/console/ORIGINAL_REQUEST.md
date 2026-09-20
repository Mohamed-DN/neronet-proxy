> Historical document, not maintained. It is the task statement of an earlier development phase of the console and does not describe the current code. For the current state read [the handbook](../../HANDBOOK.md).

# Original User Request

## Initial Request — 2026-09-01T08:21:28Z

You are the Fix Specialist for the NeroNet Enterprise Management Console frontend and security layer.

Working directory: /Users/mohamed.abouelseod/teamwork_projects/sovereign_proxy_v4_retry/console
Target files:
- console/frontend/src/App.jsx
- console/frontend/src/context/AuthContext.jsx
- console/frontend/src/services/api.js
- console/frontend/src/services/mockData.js
- console/frontend/src/components/Sidebar.jsx
- console/frontend/src/components/Topology3D.jsx
- console/frontend/src/components/GeoFencingMap.jsx
- console/frontend/src/components/NeroNukePanel.jsx
- console/frontend/src/components/OnionObfuscationPanel.jsx (or SettingsACL.jsx / new dedicated component)
- console/frontend/src/components/Overview.jsx & NodeMatrix.jsx (empty state when no nodes)

Implement ALL 6 fixes requested in ORIGINAL_REQUEST.md:
1. AUTH BYPASS: Ensure unauthenticated users without a valid JWT token in localStorage are ALWAYS shown the LoginPage. Do not auto-authenticate or mock-login unauthenticated users.
2. FAKE SEED DATA: Strip hardcoded mock/demo nodes from frontend initial state. Return empty array `[]` when no nodes exist and render clean, elegant empty states ("No mesh nodes registered yet. Click '+ Enroll Node' to generate a cryptographic Noise profile").
3. NERONUKE TIER 1 UX: Instant Kill must NOT wipe immediately. Show a confirmation + digital signature page. After signing, pin the persistent red button ("☢ DESTROY NOW") to the sidebar. Only clicking THAT red button triggers actual destruction. Keep red button visible on all views until deactivated.
4. 3D TOPOLOGY PERFORMANCE & SPIDERWEB/SPACE THEME: Optimize performance (reduce sphere segments to 8, reduce particles to 50, low charge strength -30). Apply spider-web/space aesthetic: web-like glowing semi-transparent edges, spider/cyber node geometry, dark space canvas with subtle starfield, remove cartoonish animations.
5. GEO-FENCING MAP LAG: Implement high-performance HTML5 Canvas rendering for the 2D world map with off-screen caching, pre-projected coordinates, and virtualization.
6. ONION ROUTING & OBFUSCATION PANEL: Ensure a dedicated, visible tab/panel in the sidebar ("Onion & Obfuscation" or "Traffic Cloaking") with 3-Hop Onion Obfuscation toggle, Traffic Padding / Timing Jitter settings, and Exit Node routing preferences (by ISO Country, Fast Relay, or Random Hop).

Verify `npm run build` in `console/frontend/` passes with 0 errors. Run `npm test` in `console/backend/`. Commit and push to git main.
