-- ============================================================================
-- Migration 013: netmap version and the endpoint debounce marker
-- ============================================================================
--
-- A node had to reconcile two counters (policy_epoch, route_epoch) and still had no
-- way to learn where a peer actually is. WP-202 replaces both, on the node side, with
-- one netmap version: a node compares one number, and when it advances it fetches one
-- complete document.
--
-- The counter reuses mesh_epochs rather than adding a table. It is global rather than
-- per node: a global counter can only over-signal (a node re-fetches a document that
-- turns out to be the same), never under-signal, and under-signalling is the failure
-- that leaves a revoked peer reachable. The document itself is deterministic, so a
-- node that fetches after a bump it did not need receives byte-identical content.
--
-- endpoints_bumped_at exists for one reason: a node reports its candidate endpoints on
-- every heartbeat, at 15 s per node, and an endpoint that flaps between two values
-- would otherwise bump the version on every beat and make the whole fleet re-fetch.
-- It records when an endpoint change last moved the version, so the bump is rate
-- limited to one per node per debounce window. The endpoints themselves are always
-- stored; only the version bump is held back.

INSERT INTO mesh_epochs (name, epoch) VALUES ('netmap', 1) ON CONFLICT (name) DO NOTHING;

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS endpoints_bumped_at TIMESTAMPTZ;
