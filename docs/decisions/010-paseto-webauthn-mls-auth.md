# ADR-010: PASETO / WebAuthn / MLS Authentication Stack

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Type** | `Type 2 (one-way door)` |
| **Domain** | `Security / Authentication` |
| **Date** | `2026-04-15` |
| **Author(s)** | `Claude` |
| **Reviewers** | `Accepted 2026-04-15` |

## Context

JWT has well-documented algorithm confusion attacks. WebAuthn PRF extension enables E2EE key derivation from passkeys. MLS (RFC 9420) provides forward secrecy for group messaging that NaCl box lacks. The CLI ships first and cannot perform WebAuthn ceremonies, so the auth stack must support headless flows before desktop launch.

## Problem Statement

What authentication and end-to-end encryption stack should the product adopt given a CLI-first rollout, a future desktop client, and a relay that carries group-session traffic?

### Trigger

The CLI ships before the desktop app, so the auth stack must be chosen once and support both headless (device-grant) flows today and passkey-based flows at desktop launch, without re-keying users or rebuilding the relay crypto.

## Decision

Three-tier authentication:

1. **Local daemon** -- Socket reachability plus an optional 256-bit session token (mode 0600, rotated per daemon restart). No network auth required.
2. **Control plane** -- PASETO v4 tokens: access tokens (v4.public, 15 min), refresh tokens (v4.local, 7 days, rotated on use). OAuth 2.1 + PKCE mandatory. DPoP sender-constraining for access tokens. Device Authorization Grant (RFC 8628) for CLI (launches browser for primary auth). WebAuthn/Passkeys added at desktop launch.
3. **Relay (E2EE)** -- MLS (RFC 9420) group encryption with Ed25519 KeyPackage verification for relay-mediated shared sessions.

## Alternatives Considered

### Option A: PASETO + OAuth 2.1 + MLS (Chosen)

- **What:** PASETO v4 replaces JWT; OAuth 2.1 + PKCE for web; Device Auth Grant for CLI; MLS for group E2EE.
- **Steel man:** Eliminates algorithm confusion, supports headless CLI, provides forward secrecy for groups.

### Option B: JWT (Rejected)

- **What:** Standard JWT with RS256 or ES256.
- **Why rejected:** Algorithm confusion attacks (`alg: none`, HMAC/RSA confusion) are a persistent class of vulnerability. PASETO v4 eliminates this by design.

### Option C: NaCl Box for E2EE (Rejected)

- **What:** Use NaCl `crypto_box` for pairwise encrypted relay messages.
- **Why rejected:** No forward secrecy. Compromised long-term key decrypts all past messages. Does not scale to group sessions.

### Option D: Signal Protocol (Rejected)

- **What:** Double Ratchet for pairwise E2EE, Sender Keys for groups.
- **Why rejected:** Group scalability is weaker than MLS tree-based ratcheting. Requires native FFI (libsignal) rather than a WASM-portable implementation.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
|---|-----------|----------|----------------------|
| 1 | PASETO v4 libraries for Node/TypeScript are production-ready and will remain maintained. | `paseto.io` lists v4 implementations and Auth0/Okta ecosystem commentary recognizes PASETO as a JWT alternative; confirmed via library release cadence. | We would need to fork or migrate to a different token format, re-issuing all access and refresh tokens. |
| 2 | A production-grade TypeScript MLS implementation (e.g., ts-mls) will be stable enough for V1 relay group sessions. | MLS (RFC 9420) is finalized and ts-mls is an active community implementation. | Relay E2EE falls back to X25519 + XChaCha20-Poly1305 NaCl-style pairwise encryption, losing group forward secrecy until MLS matures. |
| 3 | WebAuthn/passkeys can ship at desktop launch without blocking CLI release. | Device Authorization Grant (RFC 8628) lets the CLI complete auth via a browser handshake without WebAuthn, and passkeys can be added once desktop has a UI. | CLI release slips if any auth flow requires WebAuthn before desktop exists. |
| 4 | OAuth 2.1 + PKCE + DPoP is sufficient to mitigate token theft and replay in this deployment. | OAuth 2.1 draft consolidates best practices; DPoP sender-constraining binds tokens to keys the client controls. | If mobile or headless clients cannot perform DPoP reliably, some token-theft mitigations weaken and we must add mTLS or token binding alternatives. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
|----------|-----------|--------|-----------|------------|
| ts-mls proves immature (instability, unresolved CVEs) during V1 relay work | Med | High | Security review and MLS handshake failure rates during integration testing | Fall back to X25519 + XChaCha20-Poly1305 NaCl pairwise encryption, deferring true group forward secrecy to V2 |
| PASETO v4 library has an implementation bug (key handling, v4.local decryption) | Low | High | Security audit, fuzzing of token parsing, CVE monitoring | Pin to audited library versions; keep a cryptography adapter layer so we can swap implementations |
| Device Authorization Grant UX proves too painful for CLI users | Med | Med | CLI auth success rate and time-to-auth telemetry | Offer long-lived refresh tokens and opt-in personal access tokens for scripted environments |
| WebAuthn PRF extension is not yet supported by target browsers/devices at desktop launch | Med | Med | Browser feature-detection telemetry | Gate PRF-derived E2EE keys behind feature detection; fall back to password-derived KEK for unsupported devices |
| JWT algorithm-confusion class of attacks reappears in a different form (e.g., PASETO misuse) | Low | High | Security review, dependency scans, incident reports | Treat PASETO keys as strictly versioned and validate `v4.public` vs `v4.local` explicitly on every verify |

## Reversibility Assessment

- **Reversal cost:** Very high. Access tokens, refresh tokens, relay group keys, and passkey-derived E2EE material are all touched. Migrating off MLS would require re-encrypting historical session envelopes and re-issuing credentials.
- **Blast radius:** Control plane, relay, CLI auth, desktop passkey flows, and any third-party integration that accepts our tokens.
- **Migration path:** Introduce a second auth backend behind a version-tagged token issuer, re-issue tokens during a deprecation window, and run parallel relay crypto until clients cut over. MLS-to-alternate migration requires a key-package rotation across all active sessions.
- **Point of no return:** Once passkeys are registered on end-user devices and MLS key packages are live in the relay, reversing either requires coordinated user re-enrollment.

## Consequences

### Positive

- No algorithm confusion attack surface (PASETO v4 has exactly one algorithm per version)
- CLI ships without WebAuthn dependency; passkeys added when desktop client launches
- MLS provides forward secrecy and efficient group key rotation

### Negative (accepted trade-offs)

- PASETO is less widely adopted than JWT; fewer off-the-shelf middleware integrations
- MLS implementation complexity is higher than simple NaCl box

## Decision Validation

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan
- [x] At least one alternative was seriously considered and steel-manned
- [ ] Antithesis was reviewed by someone other than the author
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified and communicated to the team

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
|--------|--------|--------------------|------------|
| Token-related CVEs affecting our auth flows | 0 exploitable reports | Security review plus dependency scanning | `2026-10-01` |
| CLI auth completion via Device Authorization Grant | > 95% first-attempt success | CLI auth telemetry | `2026-07-01` |
| Relay group sessions using MLS (ts-mls) rather than pairwise fallback | 100% of group sessions at desktop launch, otherwise pairwise fallback documented | Relay session metrics and release review | `2026-12-01` |

## References

- [ADR-007: Collaboration Trust And Permission Model](./007-collaboration-trust-and-permission-model.md)
- [PASETO Specification](https://paseto.io/)
- [RFC 9420 -- Messaging Layer Security](https://www.rfc-editor.org/rfc/rfc9420)
- [RFC 8628 -- OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628)

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| 2026-04-15 | Proposed | Initial draft |
| 2026-04-15 | Accepted | ADR accepted |
