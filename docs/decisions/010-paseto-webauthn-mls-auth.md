# ADR-010: PASETO / WebAuthn / MLS Authentication Stack

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Domain** | `Security / Authentication` |
| **Date** | `2026-04-15` |
| **Author(s)** | `Claude` |

## Context

JWT has well-documented algorithm confusion attacks. WebAuthn PRF extension enables E2EE key derivation from passkeys. MLS (RFC 9420) provides forward secrecy for group messaging that NaCl box lacks. The CLI ships first and cannot perform WebAuthn ceremonies, so the auth stack must support headless flows before desktop launch.

## Decision

Three-tier authentication:

1. **Local daemon** -- Socket reachability plus a per-session token. No network auth required.
2. **Control plane** -- PASETO v4 tokens. OAuth 2.1 + PKCE for web clients. Device Authorization Grant (RFC 8628) for CLI (launches browser for primary auth). WebAuthn/Passkeys added at desktop launch.
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

## Consequences

### Positive

- No algorithm confusion attack surface (PASETO v4 has exactly one algorithm per version)
- CLI ships without WebAuthn dependency; passkeys added when desktop client launches
- MLS provides forward secrecy and efficient group key rotation

### Negative (accepted trade-offs)

- PASETO is less widely adopted than JWT; fewer off-the-shelf middleware integrations
- MLS implementation complexity is higher than simple NaCl box

## References

- [ADR-007: Collaboration Trust And Permission Model](./007-collaboration-trust-and-permission-model.md)
- [PASETO Specification](https://paseto.io/)
- [RFC 9420 -- Messaging Layer Security](https://www.rfc-editor.org/rfc/rfc9420)
- [RFC 8628 -- OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628)
