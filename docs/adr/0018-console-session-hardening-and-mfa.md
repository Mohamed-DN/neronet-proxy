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
