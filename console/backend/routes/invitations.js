const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { invitationAcceptLimiter } = require('../middleware/rateLimit');
const { readPageParams, pageEnvelope } = require('../utils/pagination');
const { logAuditEvent } = require('../utils/audit');
const Invitations = require('../services/InvitationService');

/**
 * Invitations into an organisation. See services/InvitationService.js for the rules.
 *
 *   POST   /api/organizations/:orgId/invitations                 owner, admin, super-admin
 *   GET    /api/organizations/:orgId/invitations                 owner, admin, super-admin
 *   DELETE /api/organizations/:orgId/invitations/:invitationId   owner, admin, super-admin
 *   POST   /api/invitations/accept                                public, rate limited
 *
 * Who may act is read from the database (platform role and the membership in :orgId),
 * not from the session's cached organisation, and never falls back to "member".
 */

function sendError(res, next, err) {
  if (err instanceof Invitations.InvitationError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  return next(err);
}

const adminRouter = express.Router({ mergeParams: true });
adminRouter.use(authenticateToken);

adminRouter.post('/', async (req, res, next) => {
  try {
    const result = await Invitations.create({ actorId: req.user.id, orgId: req.params.orgId, body: req.body || {} });
    const inv = result.invitation;
    logAuditEvent({
      eventType: 'INVITATION_CREATE',
      organizationId: inv.organization_id,
      severity: inv.role === 'member' ? 'info' : 'warn',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: inv.id,
      targetType: 'invitation',
      message: `Invitation ${inv.id} as ${inv.role} created by ${req.user.username}, expires ${new Date(inv.expires_at).toISOString()}`,
      ipAddress: req.ip,
      metadata: { role: inv.role, expires_at: inv.expires_at }
    });
    // The only time the secret leaves the server. It is not logged and not stored.
    res.set('Cache-Control', 'no-store');
    return res.status(201).json(result);
  } catch (err) {
    return sendError(res, next, err);
  }
});

adminRouter.get('/', async (req, res, next) => {
  try {
    const { limit, offset } = readPageParams(req);
    const { invitations, total } = await Invitations.list({
      actorId: req.user.id,
      orgId: req.params.orgId,
      limit,
      offset
    });
    return res.status(200).json({ invitations, ...pageEnvelope({ items: invitations, total, limit, offset }) });
  } catch (err) {
    return sendError(res, next, err);
  }
});

adminRouter.delete('/:invitationId', async (req, res, next) => {
  try {
    const inv = await Invitations.revoke({
      actorId: req.user.id,
      orgId: req.params.orgId,
      invitationId: req.params.invitationId
    });
    logAuditEvent({
      eventType: 'INVITATION_REVOKE',
      organizationId: inv.organization_id,
      severity: 'info',
      actorUserId: req.user.id,
      actorUsername: req.user.username,
      targetId: inv.id,
      targetType: 'invitation',
      message: `Invitation ${inv.id} as ${inv.role} withdrawn by ${req.user.username}`,
      ipAddress: req.ip,
      metadata: { role: inv.role }
    });
    return res.status(200).json({ invitation: inv });
  } catch (err) {
    return sendError(res, next, err);
  }
});

const publicRouter = express.Router();

// Public on purpose: it is how a person joins while self-registration is closed.
publicRouter.post('/accept', invitationAcceptLimiter, async (req, res, next) => {
  try {
    const { invitation, user } = await Invitations.accept(req.body || {});
    logAuditEvent({
      eventType: 'INVITATION_ACCEPT',
      organizationId: invitation.organization_id,
      severity: invitation.role === 'member' ? 'info' : 'warn',
      actorUserId: user.id,
      actorUsername: user.username,
      targetId: invitation.id,
      targetType: 'invitation',
      message: `Invitation ${invitation.id} accepted: account ${user.username} joined as ${invitation.role}`,
      ipAddress: req.ip,
      metadata: { role: invitation.role, user_id: user.id, invited_by: invitation.created_by }
    });
    // No session here: the person signs in normally next, so MFA enrolment and every
    // other sign-in rule apply unchanged.
    return res.status(201).json({ ok: true, username: user.username });
  } catch (err) {
    return sendError(res, next, err);
  }
});

module.exports = { adminRouter, publicRouter };
