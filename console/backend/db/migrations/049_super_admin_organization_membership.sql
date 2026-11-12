-- Repair for installs created after migration 017 ran on an empty users table: the
-- bootstrapped super-admin got neither organization_id nor a membership, so code that reads
-- memberships directly (governance, invitation role cap, audit attribution) saw the owner
-- outside every organisation. Idempotent.
UPDATE users SET organization_id = 'org-default'
WHERE role = 'super-admin' AND organization_id IS NULL
  AND EXISTS (SELECT 1 FROM organizations WHERE id = 'org-default');

INSERT INTO memberships (id, user_id, organization_id, role)
SELECT 'mem-' || substr(md5(u.id || 'org-default'), 1, 12), u.id, 'org-default', 'owner'
FROM users u
WHERE u.role = 'super-admin'
  AND EXISTS (SELECT 1 FROM organizations WHERE id = 'org-default')
  AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)
ON CONFLICT (user_id, organization_id) DO NOTHING;
