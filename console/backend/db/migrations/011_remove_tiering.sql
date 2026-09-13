-- ============================================================================
-- Migration 011: Remove commercial tiering
-- ============================================================================
--
-- NeroNet has no paid tiers. users.tier, app_bundles.tier and the per-account caps
-- were a commercial boundary, not a technical one: the overlay pool holds 4.19
-- million addresses and enrolment is rate limited, so the protections that matter
-- are elsewhere.
--
-- Deliberately NOT removed:
--
--   users.role                  authorisation, not monetisation
--   dead_man_switch.switch_tier the NeroNuke tiers (personal_user, owner_global).
--                               Same word, unrelated concept.
--
-- Run after every code reference is gone, not before: dropping a column the code
-- still selects turns a working deployment into a crashing one.

ALTER TABLE users DROP COLUMN IF EXISTS tier;
ALTER TABLE users DROP COLUMN IF EXISTS bandwidth_quota_gb;
ALTER TABLE users DROP COLUMN IF EXISTS bandwidth_used_bytes;
ALTER TABLE users DROP COLUMN IF EXISTS max_nodes;

ALTER TABLE app_bundles DROP COLUMN IF EXISTS tier;

DROP INDEX IF EXISTS idx_users_tier;
