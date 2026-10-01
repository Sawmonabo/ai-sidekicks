# ADR-010: Tokens, Passkeys And The Remote Channel

| Field         | Value                       |
| ------------- | --------------------------- |
| **Status**    | `accepted`                  |
| **Type**      | `Type 2 (one-way door)`     |
| **Domain**    | `Security / Authentication` |
| **Date**      | `2026-09-25`                |
| **Author(s)** | `Claude (AI-assisted)`      |
| **Reviewers** | `Sawmon Abo`                |

## Context

One person drives their sessions from their devices — a phone, a browser, the desktop app on another computer — and each session runs on one of their machines. Three paths need authentication and protection:

- **The local daemon**, reached over its socket by the desktop app's main process and the CLI on the same machine.
- **The control plane**, where the machine holds a hosted account, registers itself, reaches the relay and sends pushes. It is the person's own: deployed in their own Cloudflare account or on their own server, serving no one else.
- **The remote channel** between a device and a machine, carried by that relay, which must never read it.

With one person, every remote channel has exactly two ends: one device and one machine. There is no group to encrypt to. A device drives every screen of a machine — the sessions list, Settings, Sidekicks, Skills, Workflows — not one session, so a channel scoped to a session would leave most of the console unreachable from another device. Phones hold their keys in hardware that offers P-256 and no Ed25519 (the Secure Enclave, the Android Keystore). JWT has well-documented algorithm-confusion attacks. The CLI ships first and cannot run a WebAuthn ceremony. And the product builds its security on published, reviewed protocols, with no cryptographic construction of its own.

## Problem Statement

What token format, sign-in flow, passkey use and end-to-end channel should the product adopt for one person reaching their machines from their devices through a relay they deploy themselves?

### Trigger

Remote Control gives every device the whole console on every machine the person has. A device's channel must therefore carry every screen of a machine, authenticate both ends against the account's own record of trust, keep the relay blind, and be a protocol other people have analyzed — before the first release that carries Remote Control.

## Decision

1. **Local daemon.** Socket reachability plus a required 256-bit session token (mode 0600, rotated on every daemon restart), presented by the desktop app's main process and by the CLI. The renderer is not a daemon client: every renderer request is brokered by the main process through the preload bridge. [Security Architecture §Local Daemon Authentication](../architecture/security-architecture.md#local-daemon-authentication) is the full model. No network authentication is involved.

2. **Control plane: PASETO v4, device-code sign-in, DPoP.**
   - `sidekicks sign-in` runs the OAuth 2.0 Device Authorization Grant ([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)): the CLI prints a code and an address, opens the address in a browser where one exists, and waits. It runs with the service stopped and writes what it receives to the machine's credential store through the service's own custody code.
   - The control plane then issues a PASETO v4 refresh token bound to the machine's DPoP key (`cnf.jkt`), kept as its own item in the machine's credential store. It lasts until sign-out or revocation.
   - The service trades the refresh token for short-lived PASETO `v4.public` access tokens, presented with a DPoP proof on every request ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)). Each trade returns a new refresh token and spends the old one. A spent refresh token presented again revokes its whole family, and `sidekicks daemon status` then says the hosted account was signed out because a reused sign-in was detected. The access token is never stored.
   - Sign-out revokes the family.

3. **Passkeys: only in the web client, the phone apps and the device-code page.** A passkey is the owner's way in beside a device link: on a new browser or phone, `Sign in with a passkey` links that device with no other device at hand, and adding or removing a passkey is a `passkey.added` or `passkey.removed` statement in the account's chain. The WebAuthn ceremony runs only in the web client and the phone apps, and on the device-code page `sidekicks sign-in` opens, which verifies the person with a passkey before it approves a machine's sign-in and keeps nothing in the browser. The desktop app carries no WebAuthn and draws no passkey sign-in card, and no key is ever derived from a passkey.

4. **Remote channel: `Noise_KK_25519_ChaChaPoly_SHA256`, per connection.**
   - A channel joins one device and one machine and carries every session and screen on that machine. It is the Noise Protocol Framework's `Noise_KK_25519_ChaChaPoly_SHA256` handshake and transport ([The Noise Protocol Framework](https://noiseprotocol.org/noise.html)), with no construction of the product's own: nothing is designed here beyond choosing the pattern and the rekey schedule.
   - **`KK`**, because after linking each end already knows the other's static key: the device holds the machine's from the account's statement chain, and the machine holds the device's. A handshake from a key the chain does not hold fails, with nothing to click past.
   - **Identity keys and channel keys.** Each machine's identity key is the service's Ed25519 key, kept as its own credential-store item and pinned by every device; a device's identity key is P-256 in its hardware, or a non-extractable WebCrypto key in the web client; every public key carries its algorithm. Because Noise's curves are 25519 and 448 and phone hardware holds only P-256, every device and machine also keeps an X25519 channel key, whose public half is certified by its identity key in the same `device.linked`, `runtimenode.added` or `runtimenode.key_rotated` statement that trusts it. The chain stays the one record of trust ([Spec-028 §The encryption envelope](../specs/028-remote-control.md#the-encryption-envelope)).
   - **Rekeying.** A fresh handshake runs on every connection and every 10 minutes on a long one, and the old keys are erased.
   - **Profiles.** A channel profile is one full Noise protocol name, and today there is exactly one. The connection's first frame carries the channel version and the profiles the device runs; the machine answers with the first it also runs, or closes the connection when it runs none, with nothing to fall back to. Both ends put the offer and the answer into the handshake's prologue, so a relay that altered them makes the handshake fail on both ends. Nothing weaker is ever offered.
   - **Not post-quantum.** The handshake's X25519 exchange is not post-quantum: traffic recorded today could be opened once a large enough quantum computer exists, and nothing in today's channel protects against that. No reviewed hybrid profile of Noise exists yet; `Noise_XXhfs_25519+MLKEM768_ChaChaPoly_SHA256` is an open working draft with no formal analysis ([libp2p/specs#727](https://github.com/libp2p/specs/pull/727)). The channel ships no draft and no second, TLS-based connection. The hybrid `KK` profile joins once its specification is finished and reviewed for production use, as a second profile in the same first frame, ahead of today's, on the same channel keys and frames; that move is a `docs/backlog.md` entry blocked on the specification.
   - **The relay** sees the device id and machine id at connection, the channel version and the profile, frame sizes and times, and never a method, a name or a byte of a session. It holds at most one live connection per key.
   - **The implementation** is a maintained Noise library whose Diffie-Hellman can be supplied from WebCrypto, chosen and recorded in [Plan-028](../plans/028-remote-control.md) Phase 3, and it gets an outside review before the first release that carries Remote Control.

5. **No other key classes.** There is no session-scoped ephemeral key, no signed key bundle, no first-claim store, no key package and no cap on recipients: a channel's keys belong to a connection. No token is minted for dispatching work to another machine, because a session never runs anywhere but the machine it was started on, and no separate artifact-encryption key exists, because a session's artifacts stay on its machine and devices read them through the channel.

### Thesis — Why This Option

Every property the product needs from the channel is a property of two-party Noise: mutual authentication of known static keys (`KK`), forward secrecy per handshake, a published, formally analyzed construction with production precedent (WireGuard runs its `IK` sibling), and prologue binding for negotiation. The account's statement chain already names every key a machine may trust, so `KK` needs no directory, no key server and no bundle admission on the control plane: the machine's own refusal in the handshake protects the sessions. PASETO v4 removes algorithm confusion by having one algorithm per version, and a device-code sign-in lets the CLI and a machine with no desktop sign in.

### Antithesis — The Strongest Case Against [T2]

The channel is classical: a party recording traffic today gets it all once a quantum computer exists, which a hybrid construction available now would prevent. The hybrid draft could be shipped as it stands, or a TLS 1.3 connection with a hybrid group could be opened beside the channel. A web client depends on WebCrypto's X25519 and on a Noise library that accepts an outside Diffie-Hellman, which narrows the choice of library. And pinning keys with no escape hatch means a person who reinstalls a machine must remove and relink it.

### Synthesis — Why It Still Holds [T2]

An unreviewed hybrid draft is a construction no one has analyzed, which is what this decision refuses; a second, TLS-based connection doubles the surface and splits the trust record. The profile negotiation is built in from the first release, so the hybrid profile arrives as one more offered profile on the same keys and frames the day its specification is reviewed, and the docs state the classical limit plainly until then. The library constraint is a selection criterion, recorded in Plan-028 under rule 15. A reinstalled machine being refused is the property a pin exists for; the refusal names the fix.

## Alternatives Considered

### Option A: PASETO v4 with device-code sign-in and DPoP, passkeys outside the desktop app, and `Noise_KK` per connection (Chosen)

- **What:** §Decision items 1 to 5.
- **Steel man:** Every cryptographic part is a published, reviewed protocol used in production; nothing is invented. One channel per device and machine carries every screen. Trust has one record, the account's chain, which each machine verifies itself.

### Option B: JWT (Rejected)

- **What:** Standard JWT with RS256 or ES256.
- **Why rejected:** Algorithm confusion attacks (`alg: none`, HMAC/RSA confusion) are a persistent class of vulnerability. PASETO v4 eliminates this by design.

### Option C: A session-scoped pairwise envelope with an MLS upgrade path (Rejected)

- **What:** Per-session ephemeral X25519 keys signed by long-term Ed25519 identity keys and admitted by the control plane as signed bundles, HKDF-derived pairwise keys with XChaCha20-Poly1305 per recipient, a permanent first-claim store for ephemeral keys, a cap on recipients, and MLS (RFC 9420) as a later group upgrade.
- **Why rejected:** A channel scoped to one session leaves every screen outside that session unreachable from another device. The construction is the product's own composition of primitives rather than a reviewed protocol. It needs a permanent control-plane store to enforce single use of client-chosen keys, and the phones' hardware keys cannot sign its Ed25519 bundles. With one person every channel has two ends, so MLS's group machinery and its promotion gates buy nothing.

### Option D: Signal Protocol (Rejected)

- **What:** The Double Ratchet for pairwise end-to-end encryption.
- **Why rejected:** `libsignal` requires native FFI rather than a WebAssembly-portable implementation, which conflicts with the desktop Electron and browser deployment targets.

### Option E: A hybrid post-quantum handshake now (Rejected)

- **What:** Ship the draft `Noise_XXhfs_25519+MLKEM768` profile, or open a TLS 1.3 connection with a hybrid key-exchange group beside the channel.
- **Why rejected:** The Noise hybrid is an open working draft with no formal analysis, and a second, TLS-based connection is a second transport with its own trust record. The profile negotiation takes the reviewed hybrid profile later with no new transport.

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | A maintained Noise implementation for TypeScript accepts a Diffie-Hellman supplied from WebCrypto, so the web client's X25519 channel key stays non-extractable. | Not yet validated: Plan-028 Phase 3 picks the library and records the choice under rule 15. | The web client's channel key would have to be extractable, or the channel package would carry more of the protocol itself; either is decided in Plan-028 before the web client ships. |
| 2 | A hybrid post-quantum Noise profile will be specified and reviewed for production use. | [libp2p/specs#727](https://github.com/libp2p/specs/pull/727) is an open working draft. | The channel stays classical for longer, and the docs keep saying so; nothing else changes. |
| 3 | PASETO v4 can be produced and verified by a small in-house library on audited primitives. | §PASETO v4 Implementation Library. | We would fork or migrate to another token format, re-issuing every token. |
| 4 | A machine can hold its DPoP key and refresh token unattended. | Each is its own item in the operating system's credential store, which opens unattended under the person's login ([ADR-021](./021-cli-identity-key-storage-custody.md)). | Sign-in would have to be repeated at each start where the store cannot be read. |

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A flaw is found in the chosen Noise library | Low | High | Security advisories, dependency scanning in CI, the outside review | The shared channel package isolates the library; replace it with a fixed version or another implementation of the same profile. The protocol itself does not change. |
| A large enough quantum computer arrives before the hybrid profile is reviewed | Low | High | Public cryptanalysis news; the backlog entry's blocker | Recorded traffic is exposed; the docs already state it. Ship the hybrid profile the day it is reviewed. |
| A PASETO library bug (key handling, `v4.local` decryption) | Low | High | Security review, fuzzing of token parsing | Pin audited primitive versions; the in-house library is small enough to review whole. |
| A stolen device key is used from a second place | Med | Med | The relay holds one live connection per key and flags a key that keeps displacing itself | The device's card says so, and the person revokes it; every machine refuses it from the next chain head. |
| A control plane withholds a revoke from one machine | Low | Med | Every channel open exchanges the chain head | The next connection of any honest device carries the newer head, and the revoking device sends its statement to every machine it reaches. |

## Reversibility Assessment

- **Reversal cost:** High for the token format and for passkeys already registered on devices. Low for the channel's cipher: a new profile is one more entry in the first frame's offer, on the same keys.
- **Blast radius:** The control plane, the relay, every client's transport, the CLI's sign-in, and every device linked to the account.
- **Migration path:** A new profile joins the offer ahead of the old one, and a machine stops accepting the old profile once every device linked to it offers the new one. A token-format change needs a second issuer behind a version-tagged token and a re-issue.
- **Point of no return:** Once passkeys are registered on the person's devices and machines are pinned by devices, reversing requires relinking; the first release that carries Remote Control is where that begins.

## Consequences

### Positive

- No algorithm-confusion attack surface (PASETO v4 has exactly one algorithm per version).
- The CLI, and a machine with no desktop app, sign in with no WebAuthn dependency.
- One channel per device and machine carries every screen, on a published, analyzed protocol with no construction of the product's own.
- The relay learns ids, the profile, sizes and times, and nothing else, and needs no key store of its own.
- The move to a post-quantum profile needs no new transport, key or statement.

### Negative (accepted trade-offs)

- PASETO is less widely adopted than JWT, with fewer off-the-shelf integrations.
- The channel is classical until a reviewed hybrid profile exists; recorded traffic is not protected against a future quantum computer, and the docs say so.
- Every device and machine keeps a second key, the X25519 channel key, beside its identity key, because phone hardware has no X25519.
- A reinstalled machine is refused by every device until it is removed and linked again.

### Unknowns

- Which Noise library meets assumption 1; Plan-028 Phase 3 finds out and records it.
- When the hybrid profile's specification is finished and reviewed; the backlog entry tracks it.

## Decision Validation [T2]

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Frames the relay can read | None | A test that holds the relay's whole view and fails to read a payload (Plan-028 Phase 3) | Before the first release carrying Remote Control |
| An altered profile offer | Fails the handshake on both ends | Plan-028 Phase 3 test | Before the first release carrying Remote Control |
| Outside review of the channel implementation | Completed, findings fixed | The review report, linked from Plan-028 | Before the first release carrying Remote Control |
| Token-related vulnerabilities affecting our auth flows | 0 exploitable reports | Security review plus dependency scanning | At each release |

## PASETO v4 Implementation Library

PASETO v4 tokens in §Decision item 2 are produced and verified by an in-house library at `packages/crypto-paseto/`, built on `@noble/curves` (Ed25519 for `v4.public`) and `@noble/ciphers` (XChaCha20 stream cipher) + `@noble/hashes` (BLAKE2b-MAC + BLAKE2b-KDF) for `v4.local`. `v4.local` is an **encrypt-then-MAC** construction (XChaCha20 stream encryption followed by BLAKE2b-MAC over the PAE), **not** XChaCha20-Poly1305 AEAD — this matches the PASETO v4 spec ([Version4.md §v4.local](https://github.com/paseto-standard/paseto-spec/blob/master/docs/01-Protocol-Versions/Version4.md#v4local)), which deliberately replaces Poly1305 with keyed BLAKE2b.

Two third-party TypeScript PASETO libraries were evaluated and rejected:

- **`panva/paseto`** — archived by the maintainer ([GitHub archive banner](https://github.com/panva/paseto)); last npm publish `v3.1.4` ([npm](https://www.npmjs.com/package/paseto)). Its v4 support implements `v4.public` only — `v4.local` is **not implemented**, so it cannot serve the refresh token. An archived repository gets no further security patches, which puts an unpatched dependency on a security-critical path.
- **`paseto-ts`** — active, but single-maintainer and unaudited ([npm](https://www.npmjs.com/package/paseto-ts)). Concentration risk on a security-critical dependency is incompatible with this record's Type 2 classification.

The in-house path avoids both failure modes by standing on independently audited primitive libraries (`@noble/curves` — audited by Cure53, Kudelski Security and Trail of Bits; `@noble/ciphers` — audited by Cure53).

## Identity Key Storage

- **A machine** keeps its identity key, its channel key, its DPoP key and every other daemon secret each as its own item in the operating system's credential store, which opens unattended under the person's login: the login keychain on macOS, Credential Manager on Windows, the Secret Service on Linux, and one file readable only by the person where no Secret Service answers, as [ADR-021](./021-cli-identity-key-storage-custody.md) records. The CLI never holds a private key: it asks the daemon over the local socket. A key is never replaced silently: the machine's key changes only when a removed machine is linked again under its same machine id, and every device moves its pin only on the new `runtimenode.added` of that rejoin or a `runtimenode.key_rotated` statement; from then on a statement the old key signs is refused, and the old key is never trusted again.
- **A device** makes its identity key on the device and never exports it: P-256 in the iPhone's Secure Enclave, in the Android Keystore, and a non-extractable WebCrypto key in the web client ([Spec-028 §The encryption envelope](../specs/028-remote-control.md#the-encryption-envelope), [Spec-029](../specs/029-ios-remote-client.md)).
- No key is derived from a passkey.

## Related Domain Docs

- [Trust And Identity](../domain/trust-and-identity.md) — the domain model for identity material, the statement chain, fingerprints and the trust-state lifecycle that this record's primitives implement.

## References

- [ADR-007: Device Trust and Permission Model](./007-device-trust-and-permission-model.md)
- [ADR-021: Machine Identity Key Custody](./021-cli-identity-key-storage-custody.md)
- [Spec-028: Remote Control](../specs/028-remote-control.md)
- [The Noise Protocol Framework](https://noiseprotocol.org/noise.html) — the `KK` pattern, the prologue (§6) and the transport.
- [Noise Explorer](https://noiseexplorer.com/) — formal models of the Noise handshake patterns.
- [WireGuard protocol](https://www.wireguard.com/protocol/) — production precedent for a Noise handshake (`IK`).
- [libp2p/specs#727](https://github.com/libp2p/specs/pull/727) — the open working draft of a hybrid post-quantum Noise profile.
- [PASETO Specification](https://paseto.io/)
- [RFC 8628 — OAuth 2.0 Device Authorization Grant](https://www.rfc-editor.org/rfc/rfc8628)
- [RFC 9449 — OAuth 2.0 Demonstrating Proof of Possession (DPoP)](https://www.rfc-editor.org/rfc/rfc9449)
- [@noble/curves audits](https://github.com/paulmillr/noble-curves#audit) — audited primitives under the PASETO library.
- [@noble/ciphers audits](https://github.com/paulmillr/noble-ciphers#audit) — audited primitives under the PASETO library.
