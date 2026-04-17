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

JWT has well-documented algorithm confusion attacks. WebAuthn PRF extension enables E2EE key derivation from passkeys. Relay-mediated group traffic requires end-to-end encryption the relay cannot read. The CLI ships first and cannot perform WebAuthn ceremonies, so the auth stack must support headless flows before desktop launch. For V1, the relay E2EE layer must ship on primitives whose production-readiness is already established; a full Messaging Layer Security (MLS, RFC 9420) deployment is deferred to V1.1 so that an audited MLS implementation can be selected before it becomes user-facing.

## Problem Statement

What authentication and end-to-end encryption stack should the product adopt given a CLI-first rollout, a future desktop client, and a relay that carries group-session traffic?

### Trigger

The CLI ships before the desktop app, so the auth stack must be chosen once and support both headless (device-grant) flows today and passkey-based flows at desktop launch, without re-keying users or rebuilding the relay crypto.

## Decision

Three-tier authentication:

1. **Local daemon** -- Socket reachability plus an optional 256-bit session token (mode 0600, rotated per daemon restart). No network auth required.
2. **Control plane** -- PASETO v4 tokens: access tokens (v4.public, 15 min), refresh tokens (v4.local, 7 days, rotated on use). OAuth 2.1 + PKCE mandatory. DPoP sender-constraining for access tokens. Device Authorization Grant (RFC 8628) for CLI (launches browser for primary auth). WebAuthn/Passkeys added at desktop launch.
3. **Relay (E2EE)** -- V1 ships pairwise X25519 ECDH + XChaCha20-Poly1305 via the audited `@noble/curves` and `@noble/ciphers` libraries. Each session establishes **ephemeral X25519 key pairs** per participant (generated at session start, zeroed at session end), authenticated by each participant's long-term Ed25519 identity key. A per-session symmetric key is derived via HKDF-SHA256 from the ECDH shared secret and used with XChaCha20-Poly1305 (24-byte random nonce, 16-byte authentication tag). This design provides **session-granularity forward secrecy** — compromise of the long-term Ed25519 identity key does not reveal past session keys because the X25519 material is discarded at session end. Messaging Layer Security (MLS, RFC 9420) via an audited implementation is the V1.1 upgrade path and will replace the pairwise layer once promotion gates are met (see Assumption #2 and Success Criteria). V1 pairwise sessions are capped at ≤10 active participants to keep the N² fan-out cost bounded.

## Alternatives Considered

### Option A: PASETO + OAuth 2.1 + pairwise X25519/XChaCha20-Poly1305 (Chosen)

- **What:** PASETO v4 replaces JWT; OAuth 2.1 + PKCE for web; Device Auth Grant for CLI; pairwise X25519 ECDH with ephemeral per-session keys + XChaCha20-Poly1305 for relay E2EE; long-term Ed25519 identity keys authenticate the X25519 handshake; MLS (RFC 9420) reserved for V1.1 upgrade.
- **Steel man:** Eliminates algorithm confusion. Supports headless CLI. Ships on `@noble/curves` and `@noble/ciphers`, both independently audited (Cure53, Kudelski Security) and widely deployed. Delivers session-granularity forward secrecy via ephemeral X25519 at session start, which matches the well-studied TLS 1.3 ephemeral-handshake pattern and Signal's X3DH construction.

### Option B: JWT (Rejected)

- **What:** Standard JWT with RS256 or ES256.
- **Why rejected:** Algorithm confusion attacks (`alg: none`, HMAC/RSA confusion) are a persistent class of vulnerability. PASETO v4 eliminates this by design.

### Option C: MLS at V1 via `ts-mls` or equivalent TypeScript implementation (Rejected for V1, retained as V1.1 target)

- **What:** Ship MLS (RFC 9420) group encryption at V1 using a TypeScript MLS implementation.
- **Why rejected for V1:** As of 2026-04-17, no TypeScript MLS implementation has a publicly-published third-party security audit. `ts-mls` is a single-maintainer project at v2.0.0-rc.10. Rust implementations (OpenMLS, mls-rs) are stronger candidates but require a WASM bridge or native sidecar and have also not published third-party audits. Shipping unaudited group crypto in V1 fails the safety bar set by the rest of the security stack. MLS remains the V1.1 upgrade target because its post-compromise security and efficient group rekeying materially exceed what pairwise primitives can offer; see Success Criteria for the promotion gates.

### Option D: Signal Protocol (Rejected)

- **What:** Double Ratchet for pairwise E2EE, Sender Keys for groups.
- **Why rejected:** Group scalability at size is weaker than MLS tree-based ratcheting, and the V1.1 upgrade target is therefore MLS. `libsignal` also requires native FFI rather than a WASM-portable implementation, which conflicts with the desktop Electron and browser deployment targets.

### Option E: Long-term X25519 per participant with no ephemeral handshake (Rejected)

- **What:** Each participant holds a long-term X25519 key; session traffic is encrypted with a symmetric key derived directly from the long-term ECDH shared secret.
- **Why rejected:** No forward secrecy. Compromise of any participant's long-term X25519 key decrypts all past and future sessions with that peer. Option A's ephemeral-per-session design eliminates this failure mode at negligible additional cost.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
|---|-----------|----------|----------------------|
| 1 | PASETO v4 libraries for Node/TypeScript are production-ready and will remain maintained. | `paseto.io` lists v4 implementations and Auth0/Okta ecosystem commentary recognizes PASETO as a JWT alternative; confirmed via library release cadence. | We would need to fork or migrate to a different token format, re-issuing all access and refresh tokens. |
| 2 | An audited MLS implementation (OpenMLS, mls-rs, or a post-audit TypeScript implementation) will be available for the V1.1 upgrade within 12–18 months of V1 GA. | RFC 9420 is finalized. OpenMLS (Rust, MIT) and mls-rs (Rust, Apache-2.0, maintained by AWS Labs) are active codebases; OpenMLS has a documented advisory-disclosure process (two GHSA advisories published 2025–26). No TypeScript implementation has a published third-party audit as of 2026-04-17. The V1 pairwise layer stands on its own for the V1 product horizon; MLS promotion is therefore schedule-driven, not schedule-critical. | V1.1 MLS upgrade slips. V1 pairwise layer continues to serve. Post-compromise security and per-message ratcheting remain unshipped until an audited MLS implementation ships behind a feature flag and meets the promotion gates in Success Criteria. |
| 3 | WebAuthn/passkeys can ship at desktop launch without blocking CLI release. | Device Authorization Grant (RFC 8628) lets the CLI complete auth via a browser handshake without WebAuthn, and passkeys can be added once desktop has a UI. | CLI release slips if any auth flow requires WebAuthn before desktop exists. |
| 4 | OAuth 2.1 + PKCE + DPoP is sufficient to mitigate token theft and replay in this deployment. | OAuth 2.1 draft consolidates best practices; DPoP sender-constraining binds tokens to keys the client controls. | If mobile or headless clients cannot perform DPoP reliably, some token-theft mitigations weaken and we must add mTLS or token binding alternatives. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
|----------|-----------|--------|-----------|------------|
| A CVE or implementation flaw surfaces in `@noble/curves` or `@noble/ciphers` affecting the V1 pairwise layer | Low | High | GitHub advisory feed, npm audit, dependency scanning in CI, paulmillr/noble-curves and noble-ciphers release notes | Pin to audited library versions; the cryptography adapter layer (`packages/crypto`) isolates primitive selection so `@noble` can be swapped for a fixed version or alternative implementation without cross-cutting changes. Zeroization of ephemeral X25519 material at session end bounds blast radius to future sessions only. |
| V1.1 MLS promotion gates are not met on time (no audited implementation published; interop not reached; soak period fails) | Med | Med | Quarterly security review comparing V1.1 target date against promotion-gate status | Accept V1.1 slip. V1 pairwise layer continues to serve. The adapter layer in `packages/crypto` keeps the V1 implementation isolated so the pairwise layer can be maintained independently. |
| PASETO v4 library has an implementation bug (key handling, v4.local decryption) | Low | High | Security audit, fuzzing of token parsing, CVE monitoring | Pin to audited library versions; keep a cryptography adapter layer so we can swap implementations |
| Device Authorization Grant UX proves too painful for CLI users | Med | Med | CLI auth success rate and time-to-auth telemetry | Offer long-lived refresh tokens and opt-in personal access tokens for scripted environments |
| WebAuthn PRF extension is not yet supported by target browsers/devices at desktop launch | Med | Med | Browser feature-detection telemetry | Gate PRF-derived E2EE keys behind feature detection; fall back to password-derived KEK for unsupported devices |
| JWT algorithm-confusion class of attacks reappears in a different form (e.g., PASETO misuse) | Low | High | Security review, dependency scans, incident reports | Treat PASETO keys as strictly versioned and validate `v4.public` vs `v4.local` explicitly on every verify |

## Reversibility Assessment

- **Reversal cost:** Very high for PASETO and passkey layers (tokens, refresh tokens, passkey-derived E2EE material are all touched). Moderate for the relay E2EE layer specifically: V1 relay ciphertexts are per-session ephemeral, so re-keying on upgrade to V1.1 MLS does not require re-encrypting historical envelopes — only new sessions adopt the new cipher suite.
- **Blast radius:** Control plane, relay, CLI auth, desktop passkey flows, and any third-party integration that accepts our tokens.
- **Migration path:** Introduce a second auth backend behind a version-tagged token issuer, re-issue tokens during a deprecation window. For the V1 → V1.1 relay E2EE upgrade, add MLS behind a feature flag, run it in parallel with the pairwise layer during the soak period, negotiate cipher suite at session start based on participant support, and promote MLS to default once the Success Criteria gates pass.
- **Point of no return:** Once passkeys are registered on end-user devices, reversing requires coordinated user re-enrollment. The pairwise-vs-MLS relay decision is per-session and carries no such lock-in within the V1 horizon.

## Consequences

### Positive

- No algorithm confusion attack surface (PASETO v4 has exactly one algorithm per version)
- CLI ships without WebAuthn dependency; passkeys added when desktop client launches
- V1 relay E2EE ships on independently-audited primitives (`@noble/curves`, `@noble/ciphers`), delivering session-granularity forward secrecy from day one
- V1.1 MLS upgrade path is explicit and gated on concrete, testable criteria rather than vendor marketing

### Negative (accepted trade-offs)

- PASETO is less widely adopted than JWT; fewer off-the-shelf middleware integrations
- V1 pairwise layer scales O(N²) in per-message work: sender encrypts plaintext once per recipient. V1 participant cap (≤10) bounds the cost; MLS tree-based ratcheting at V1.1 reduces this to O(log N)
- V1 does not provide post-compromise security or per-message ratcheting; those properties arrive with the V1.1 MLS upgrade

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
| V1 relay sessions using the pairwise X25519 + XChaCha20-Poly1305 layer | 100% of relay-mediated sessions | Relay session metrics; release review confirms no code path attempts MLS at V1 | `2026-12-01` |

### V1.1 MLS Promotion Gates (all three required before MLS ships as the default relay cipher)

| Gate | Criterion | Evidence Required |
|------|-----------|-------------------|
| External audit | A named reputable security audit firm has completed a third-party security audit of the selected MLS implementation (OpenMLS, mls-rs, or post-audit TypeScript implementation) and published the report or a vendor-released summary. | Published audit report URL or audit firm engagement letter filed in `docs/audits/`. |
| Interop | The implementation passes interoperability test vectors against at least one other independent MLS implementation at a pinned commit. | CI job exercising MLS interop matrix; test result artifacts archived per release. |
| Production soak | MLS ships behind a feature flag to opt-in sessions for ≥ 4 weeks with a < 1% session-level error rate attributable to the MLS code path. | Telemetry dashboard showing soak window, error rate, and decision-review sign-off recorded in release notes. |

## References

- [ADR-007: Collaboration Trust And Permission Model](./007-collaboration-trust-and-permission-model.md)
- [PASETO Specification](https://paseto.io/)
- [RFC 9420 -- Messaging Layer Security](https://www.rfc-editor.org/rfc/rfc9420)
- [RFC 8628 -- OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628)
- [RFC 5869 -- HKDF (HMAC-based Extract-and-Expand Key Derivation Function)](https://www.rfc-editor.org/rfc/rfc5869)
- [RFC 8446 §1.2 -- TLS 1.3 forward secrecy via ephemeral key exchange](https://www.rfc-editor.org/rfc/rfc8446#section-1.2)
- [Bernstein 2011 -- Extending the Salsa20 nonce (XSalsa20/XChaCha20 construction)](https://cr.yp.to/snuffle/xsalsa-20110204.pdf) — primary source for XChaCha20 construction; `draft-irtf-cfrg-xchacha-03` was archived as a Dead IRTF Document
- [Signal X3DH Specification](https://signal.org/docs/specifications/x3dh/) — precedent for long-term-identity-authenticated ephemeral X25519 handshake
- [@noble/curves audits (Cure53, Kudelski Security)](https://github.com/paulmillr/noble-curves#audit) — audited primitive library selection for V1
- [@noble/ciphers audits](https://github.com/paulmillr/noble-ciphers#audit) — audited AEAD library selection for V1
- [OpenMLS (Rust MLS implementation, MIT)](https://github.com/openmls/openmls) — V1.1 MLS promotion candidate
- [mls-rs (Rust MLS implementation, Apache-2.0, AWS Labs)](https://github.com/awslabs/mls-rs) — V1.1 MLS promotion candidate

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| 2026-04-15 | Proposed | Initial draft |
| 2026-04-15 | Accepted | ADR accepted |
| 2026-04-17 | Rewritten | Pairwise X25519 + XChaCha20-Poly1305 declared V1 relay encryption choice; MLS promoted to V1.1 upgrade path with explicit audit / interop / soak gates (BL-048). |
