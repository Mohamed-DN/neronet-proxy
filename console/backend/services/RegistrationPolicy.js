/**
 * Whether POST /api/auth/register is open to anyone who can reach the server.
 *
 * A self-registered account has no organisation of its own and is treated as a member
 * of the default one, where it could create a node or a device and become a peer of
 * the whole fleet (security review, 10 November 2026, C1). A production install
 * therefore keeps registration closed and an administrator creates the accounts;
 * SOVEREIGN_ALLOW_SELF_REGISTRATION=true opens it deliberately. Outside production it
 * stays open so development and the test suites need no setup.
 *
 * Read at request time: an operator's change takes effect on restart without a rebuild,
 * and tests can exercise both settings.
 */
function selfRegistrationAllowed() {
  const setting = process.env.SOVEREIGN_ALLOW_SELF_REGISTRATION;
  if (setting !== undefined && setting !== '') return setting === 'true';
  return process.env.NODE_ENV !== 'production';
}

module.exports = { selfRegistrationAllowed };
