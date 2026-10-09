# ADR 0018: Console Session Hardening and Multi-Factor Authentication (MFA)

- Status: Accepted
- Date: 2026-09-21
- Decision label: D11

## Context

Security audit identified critical web console session vulnerabilities:
1. Session tokens and refresh tokens were stored client-side in browser `localStorage`, exposing them to exfiltration via cross-site scripting (XSS) or browser extension compromise.
2. Refresh tokens were not rotated upon use and lacked single-use replay detection.
3. User roles were embedded in long-lived tokens without re-reading the source of truth in PostgreSQL during refresh, allowing revoked or demoted accounts to retain elevated permissions.
4. Administrative accounts (`super-admin`) lacked mandatory Multi-Factor Authentication (MFA), leaving deployments vulnerable to credential stuffing and brute-force attacks.
5. Password changes did not verify the user's current password.

## Decision

We adopt enterprise session hardening and mandatory TOTP MFA:

1. **HttpOnly Strict Cookies**:
   - Access tokens are issued in `HttpOnly; SameSite=Strict; Path=/api; Secure` cookies.
   - Refresh tokens are issued in `HttpOnly; SameSite=Strict; Path=/api/auth/refresh; Secure` cookies.
   - `document.cookie` cannot read session tokens, and `localStorage` remains empty.
   - Bearer authorization headers remain supported for programmatic API callers, CLI tools, and automated testing.

2. **Single-Use Refresh Token Rotation & Replay Detection**:
   - Every refresh token is stored as a SHA-256 hash in the `refresh_tokens` table.
   - Using a refresh token atomically marks it revoked (`revoked_at = NOW()`) and issues a fresh refresh token.
   - If an already-revoked refresh token is presented (replay attack), all active refresh tokens for that user are immediately revoked, and the request is rejected with `401 Unauthorized`.

3. **Role Re-Read on Refresh**:
   - Every `/api/auth/refresh` query queries the `users` table directly to fetch the latest `role` and `status`.
   - Role modifications (demotion/promotion) take effect immediately upon next token refresh.

4. **Mandatory TOTP MFA for Administrators**:
   - Accounts with role `super-admin` are required to configure and verify TOTP (RFC 6238, 6-digit, 30s step) using Google Authenticator, Authy, or 1Password.
   - Password authentication for MFA-enrolled or admin accounts returns `{ mfa_required: true, mfa_token: ... }`.
   - Full session and refresh cookies are granted only after successful verification of the 6-digit time-based code (`POST /api/auth/mfa/verify`).
   - Backup recovery codes are generated and stored hashed for disaster recovery.

5. **Current Password Verification**:
   - Self-service password changes require presenting `current_password`. Requests with incorrect or missing current passwords return `400 Bad Request`.

## Consequences

- Web browsers store zero credentials in `localStorage`.
- Compromising a refresh token yields at most one use before replay detection invalidates the entire session chain.
- Administrators cannot log in with only a password; TOTP hardware/app token is strictly enforced.

## Amendment, September 2026: the console side

The server side of point 1 was built, but the console kept storing both tokens in
`localStorage` until September 2026 (`console/frontend/src/services/authToken.ts`),
so the consequence "zero credentials in `localStorage`" did not hold. Now:

- The console holds the access token in memory only and never stores the refresh
  token; it relies on the refresh cookie.
- After a reload the console calls `/api/auth/refresh` with the cookie to get an
  access token (`resumeSession` in `apiClient.ts`).
- On load it removes the keys earlier versions wrote.
- `authToken.test.ts` fails if a sign-in, refresh or sign-out writes to web storage.

## Amendment, September 2026: MFA as implemented

Point 4 did not hold. MFA was required only of accounts that had enrolled, and of the
super-admin only when `SOVEREIGN_MFA_MANDATORY=true` or a client sent the header
`X-Enforce-MFA`. The console could not complete an MFA sign-in at all. And
`/api/auth/mfa/setup` accepted the password-step token, replaced the account's secret
and returned the new one, so the password alone was enough to sign in to an account
with MFA.

Now: `SOVEREIGN_MFA_MANDATORY` is `off`, `admins` or `all` (default `admins` in
production), the header is ignored, the password-step token cannot enrol over an
existing authenticator and is single-use, a new authenticator is kept pending until a
code from it is confirmed, and the console sign-in handles the code, recovery codes and
enrolment.

## Amendment, October 2026: current access authority

Authenticated console HTTP requests and topology WebSocket connections now read
the account's current status, platform role, organization and membership from
PostgreSQL. Module guards share the HTTP request's verified decision. Open sockets
revalidate before event delivery and close on token expiry, including while idle.
An unavailable authority fails closed.

Root-password compartment grants remain tenant-bound. Enrollment separately
retains the signed tenant context and its transactional lifecycle checks, so a
transfer requires a fresh tenant-context token before creating nodes there.
See [console session authority](../en/console-session-authority.md) for behavior,
verification and limits. Durable access-session families, cache-loss revocation
and multi-replica failover remain separate acceptance work.
