-- ============================================================================
-- NeroNet Sovereign Mesh Enterprise Management Console
-- Migration 006: Sequence-backed overlay VIP allocation
-- ============================================================================
--
-- Allocation used to read every row of the nodes table and then scan offsets upward
-- in JavaScript until it found a free one. Measured on this codebase, the scan alone
-- costs 0.8 ms at 1,000 nodes, 6.7 ms at 10,000 and 71 ms at 100,000 -- and Node is
-- single threaded, so at scale that is 71 ms during which the whole API is stopped,
-- for every registration.
--
-- It was also racy. Two concurrent registrations read the same set of used addresses
-- and picked the same free one; overlay_ipv4 and overlay_ipv6 are both UNIQUE, so
-- the loser got an opaque constraint violation.
--
-- A sequence gives an atomic, contention-free counter with no scan at all. The pool
-- is 100.64.0.0/10, about 4.19 million addresses.
--
-- Deliberate trade-off: released addresses are not reused. Reclaiming them would
-- reintroduce a scan, and at 4.19 million addresses a fleet churning a thousand
-- nodes a day would take over eleven years to exhaust the space. When that stops
-- being true, the answer is a free list, not a scan.

CREATE SEQUENCE IF NOT EXISTS overlay_vip_seq START WITH 1 INCREMENT BY 1;

-- Advance past every address already handed out, so existing nodes keep theirs and
-- no new node is issued a duplicate.
DO $$
DECLARE
  highest bigint := 0;
BEGIN
  SELECT COALESCE(MAX(
           (split_part(overlay_ipv4, '.', 2)::int - 64) * 65536
         + (split_part(overlay_ipv4, '.', 3)::int) * 256
         + (split_part(overlay_ipv4, '.', 4)::int)
         ), 0)
    INTO highest
    FROM nodes
   WHERE overlay_ipv4 ~ '^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}$';

  IF highest > 0 THEN
    PERFORM setval('overlay_vip_seq', highest + 1, false);
    RAISE NOTICE 'Overlay VIP sequence positioned after the highest address in use (offset %).', highest;
  END IF;
END;
$$;
