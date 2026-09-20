> Historical document, not maintained. It is the feature list of an earlier development phase of the console and does not describe the current code. For the current state read [the handbook](../../HANDBOOK.md).

# Project: NeroNet Enterprise Management Console — 6 Critical UX & Security Fixes

## Architecture
The NeroNet Sovereign Mesh Control Plane v4.0 consists of:
- **Frontend**: React 18 SPA (Vite + Tailwind CSS + Three.js + Lucide Icons + Recharts).
- **Backend**: Express.js API server + WebSocket live event bus + Valkey session cache + SQLite / PostgreSQL storage.
- **Engines**:
  - `AuthContext`: Centralized JWT authentication, session verification, and role-based access control.
  - `NodeMatrix`: Mesh cryptographic node inventory with graceful empty states and enrollment workflows.
  - `NeroNuke`: Multi-tier self-destruct protocol (Tier 1: Multi-stage Instant Kill with Confirmation -> Digital Signature -> Armed Sidebar Red Button `☢ DESTROY NOW` -> Destruction).
  - `Topology3D`: WebGL Three.js force-directed graph with spiderweb filaments, cybernetic nodes, 3D cosmos starfield, and optimized physics.
  - `GeoFencingMap`: Dual-layer HTML5 Canvas rendering engine with equirectangular coordinate projection, offscreen caching, and 60 FPS RAF dynamic beacon glow.
  - `OnionObfuscationPanel`: Dedicated console panel for 3-Hop Onion toggling, Traffic Padding (Chaff/CBR), Timing Jitter modulation, and Exit Node Routing preferences.

## Feature Inventory
| # | Feature | Description | Milestone | Source | Status |
|---|---|---|---|---|:---:|
| 1 | Auth Bypass Fix | Strict unauthenticated redirection to `/login`, single unified AuthContext, remove mock user auto-login, boot-time `api.auth.me()` session verification. | M1 | ORIGINAL_REQUEST §1 | DONE |
| 2 | Fake Seed Data Removal & Empty States | Frontend initial state returns `[]`, graceful empty state in NodeMatrix ("No mesh nodes registered yet" + "+ Enroll Node" CTA), dynamic count propagation in Overview/Sidebar/App.jsx. | M2 | ORIGINAL_REQUEST §2 | DONE |
| 3 | NeroNuke Tier 1 Multi-Stage UX | Confirmation -> Digital Signature authorization page -> Pin persistent glowing red button (`☢ DESTROY NOW`) to sidebar -> Only sidebar button triggers actual wipe. | M3 | ORIGINAL_REQUEST §3 | DONE |
| 4 | 3D Topology Performance & Spiderweb Theme | Low particle count (<=50), 8-segment / faceted cyber geometry, memoized Three.js materials, D3 force charge tuned to -30, deep space `#030712` canvas with 400-point 3D starfield, translucent glowing web filaments. | M4 | ORIGINAL_REQUEST §4 | DONE |
| 5 | Geo-Fencing Canvas Map Engine | High-performance dual-layer HTML5 canvas, offscreen background caching, 60 FPS RAF dynamic beacon rendering, true Equirectangular `(lat, lon)` projection, fast distance-squared raycasting. | M5 | ORIGINAL_REQUEST §5 | DONE |
| 6 | Onion Routing & Obfuscation Controls | Dedicated top-level tab/panel for 3-Hop Onion cloaking, traffic padding (chaff/CBR), timing jitter, exit country preferences, and per-node onion routing toggles. | M6 | ORIGINAL_REQUEST §6 | DONE |
| 7 | Full Test & Build Suite Pass | Pass `npm run build` in `console/frontend/`, `npm test` in `console/backend/` (140/140 tests), and `python3 tests/e2e/console_runner.py --tier all` (166/166 tests). | M7 | ORIGINAL_REQUEST §Verification | DONE |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|:---:|
| M1 | Auth & Core State Hardening | `frontend/src/context/AuthContext.jsx`, `frontend/src/App.jsx`, `backend/server.js` | none | DONE |
| M2 | Seed Data Removal & NodeMatrix Empty State | `frontend/src/components/NodeMatrix.jsx`, `frontend/src/components/Overview.jsx`, `frontend/src/components/Sidebar.jsx` | M1 | DONE |
| M3 | NeroNuke Tier 1 Multi-Stage UX | `frontend/src/components/NeroNukePanel.jsx`, `frontend/src/components/Sidebar.jsx`, `frontend/src/App.jsx` | M1 | DONE |
| M4 | 3D Topology Optimization & Spiderweb Theme | `frontend/src/components/Topology3D.jsx` | none | DONE |
| M5 | Geo-Fencing Canvas Map Engine | `frontend/src/components/GeoFencingMap.jsx` | none | DONE |
| M6 | Onion Routing & Obfuscation Controls Panel | `frontend/src/components/OnionObfuscationPanel.jsx`, `frontend/src/components/Sidebar.jsx`, `frontend/src/App.jsx` | M1 | DONE |
| M7 | Test Suite Pass & Verification Gate | `console/backend/package.json`, verify all builds and test runners | M1-M6 | DONE |

## Interface Contracts
### AuthContext ↔ App
- `useAuth()` provides `{ token, user, role, loading, login, logout, refreshUser }`.
- `loading === true`: renders crypto session verifying splash.
- `!token || !user`: renders `<LoginPage />`.

### NeroNuke ↔ Sidebar ↔ App
- `nukeArmed`: boolean state indicating instant kill arming.
- `nukeScheduledAt`: string timestamp or null for scheduled kill.
- Sidebar pins red button with exact text: `"☢ DESTROY NOW"`.
- Clicking `"☢ DESTROY NOW"` fires `onExecuteWipe` calling `api.nuke.userSelfDestruct('DELETE MY ACCOUNT', true)`.

### GeoFencingMap ↔ Canvas
- `WORLD_COUNTRIES_GEO`: maps ISO country code to `{ name, lat, lon, region }`.
- `projectEquirectangular(lat, lon, width, height)`: Equirectangular projection.
- Canvas hit testing: `(mouseX - x)^2 + (mouseY - y)^2 <= r^2`.

### OnionObfuscationPanel ↔ API
- `api.nodes.update(id, { onion_routing_enabled, onion_hops })` / `api.nodes.action(id, 'toggle_onion')`.
- Global settings: Mesh-wide 3-hop toggle, traffic padding modes, timing jitter ranges, exit country ISO selector.
