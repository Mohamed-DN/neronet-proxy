-- Preserve legacy organization owner/admin authority at upgrade, once. Runtime
-- governance uses memberships exclusively so removing one cannot reactivate the
-- residual users.role privilege. Existing memberships may represent a demotion;
-- never overwrite them with the legacy role.
INSERT INTO memberships (id, user_id, organization_id, role)
SELECT 'mem-gov-' || md5(id || ':' || COALESCE(organization_id, 'org-default')),
       id, COALESCE(organization_id, 'org-default'), role
  FROM users
 WHERE role IN ('owner', 'admin')
ON CONFLICT (user_id, organization_id) DO NOTHING;
