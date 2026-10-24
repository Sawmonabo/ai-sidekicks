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

- **The local daemon**, reached over its socket by the desktop app's client helper and the CLI on the same machine.
- **The control plane**, where the machine holds a hosted account, registers itself, reaches the relay and sends pushes. It is the person's own: deployed in their own Cloudflare account or on their own server, serving no one else.
- **The remote channel** between a device and a machine, carried straight across the network where the two can reach each other and by that relay otherwise, which must never read it.

With one person, every remote channel has exactly two ends: one device and one machine. There is no group to encrypt to. A device drives every screen of a machine — the sessions list, Settings, Sidekicks, Skills, Workflows — not one session, so a channel scoped to a session would leave most of the console unreachable from another device. The iPhone holds its keys in hardware that offers P-256 and no Ed25519 (the Secure Enclave). JWT has well-documented algorithm-confusion attacks. The CLI ships first and cannot run a WebAuthn ceremony. And the product builds its security on published, reviewed protocols, with no cryptographic construction of its own.

## Problem Statement

What token format, sign-in flow, passkey use and end-to-end channel should the product adopt for one person reaching their machines from their devices through a relay they deploy themselves?

### Trigger

Remote Control gives every device the whole console on every machine the person has. A device's channel must therefore carry every screen of a machine, authenticate both ends against the account's own record of trust, keep the relay blind, and be a protocol other people have analyzed — before the first release that carries Remote Control.

## Decision

1. **Local daemon.** Socket reachability plus a required 256-bit session token (mode 0600, rotated on every daemon restart), presented by the CLI and, on Linux and Windows and in an unpackaged development build on macOS, by the desktop app's client helper, an Electron `utilityProcess`, in the `connection.initialize` of its own daemon connection; the daemon admits the packaged app's helper on macOS by its code signature instead. The renderer is not a daemon client: its daemon and control-plane calls travel over a `MessagePort` that main hands the page through the preload, to the helper, which checks each call against its method allowlist and params check and returns only the sanitized reply. Main's own daemon calls reach the helper over `parentPort`, through the same allowlist, and main keeps the file tokens. Neither main nor the renderer holds the session token. [Security Architecture §Local Daemon Authentication](../architecture/security-architecture.md#local-daemon-authentication) is the full model. No network authentication is involved.

2. **Control plane: PASETO v4, an authorization-code sign-in the service runs, DPoP.**
   - The background service runs every sign-in, whether Settings › Devices' `Sign in` or `sidekicks account login` started it, and nothing asks it to stop: the OAuth authorization code flow for a native app ([RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)) with PKCE S256 ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)), its request pushed to the control plane first ([RFC 9126](https://www.rfc-editor.org/rfc/rfc9126)) under a DPoP proof, and the browser sent back to a one-time listener on `127.0.0.1`, which checks `state`, `iss` ([RFC 9207](https://www.rfc-editor.org/rfc/rfc9207)) and the Host header. Where no browser can reach the machine, the command line takes a code the relay's page shows, worthless without the PKCE verifier only the service holds ([RFC 10027](https://www.rfc-editor.org/rfc/rfc10027) §6.1.17).
   - The control plane then issues a PASETO v4 refresh token bound to the machine's DPoP key (`cnf.jkt`), kept as its own item in the machine's credential store. It lasts until sign-out or revocation.
   - The service trades the refresh token for short-lived PASETO `v4.public` access tokens, presented with a DPoP proof on every request ([RFC 9449](https://www.rfc-editor.org/rfc/rfc9449)). Each trade returns a new refresh token and spends the old one. A spent refresh token presented again revokes its whole family, and `sidekicks daemon status` then prints `Hosted account: signed out · its sign-in was used in two places; sign in again`. The access token is never stored.
   - Sign-out deletes the DPoP key first, so the refresh token can never be traded again, then revokes the family ([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)) as soon as the relay can be reached.

3. **Passkeys: only in the web client, the iPhone app and the sign-in page.** A passkey is the owner's way in beside a device link: on a new browser or phone, `Sign in with a passkey` links that device with no other device at hand, and adding or removing a passkey is an `account.passkey.added` or `account.passkey.removed` statement in the account's chain. The WebAuthn ceremony runs only in the web client and the iPhone app, and on the relay's sign-in page a machine's sign-in opens, which verifies the person with a passkey before it approves that sign-in and keeps nothing in the browser. The desktop app carries no WebAuthn and draws no passkey sign-in card, and no key is ever derived from a passkey.

4. **Remote channel: `Noise_KK_25519_AESGCM_SHA256` or `Noise_KK_25519_ChaChaPoly_SHA256`, per connection.**
   - A channel joins one device and one machine and carries every session and screen on that machine. It is the Noise Protocol Framework's `KK` handshake and transport on X25519 and SHA-256, under one of the two profiles below ([The Noise Protocol Framework](https://noiseprotocol.org/noise.html)), with no construction of the product's own: nothing is designed here beyond choosing the pattern and the rekey schedule.
   - **`KK`**, because after linking each end already knows the other's static key: the device holds the machine's from the account's statement chain, and the machine holds the device's. A handshake from a key the chain does not hold fails, with nothing to click past.
   - **Identity keys and channel keys.** Each machine's identity key is the service's Ed25519 key, kept as its own credential-store item and pinned by every device; a device's identity key is P-256 in its hardware, or a non-extractable WebCrypto key in the web client; every public key carries its algorithm. The web client's channel key is kept in IndexedDB wrapped (`wrapKey`, `pkcs8`) under a non-extractable AES-GCM key of its own and unwrapped at each load into a non-extractable X25519 key, extractable only inside the one `generateKey` and `wrapKey` that make it. Because Noise's curves are 25519 and 448 and phone hardware holds only P-256, every device and machine also keeps an X25519 channel key, whose public half is certified by its identity key in the same `device.linked` or `machine.added` statement that trusts it. The chain stays the one record of trust ([Spec-027 §The encryption envelope](../specs/027-remote-control.md#the-encryption-envelope)).
   - **Rekeying.** A fresh handshake runs on every connection and every 10 minutes on a long one, and the old keys are erased.
   - **Profiles.** A channel profile is one full Noise protocol name, and there are two, offered in this order: `Noise_KK_25519_AESGCM_SHA256` first and `Noise_KK_25519_ChaChaPoly_SHA256` second, because WebKit's WebCrypto refuses ChaCha and AES-GCM costs three to six times less there. The connection's first frame carries the channel version and the profiles the device runs; the machine answers with the first it also runs, or closes the connection when it runs none, with nothing to fall back to. Both ends put the offer and the answer into the handshake's prologue, so a relay that altered them makes the handshake fail on both ends. Nothing weaker is ever offered.
   - **Not post-quantum.** The handshake's X25519 exchange is not post-quantum: traffic recorded today could be opened once a large enough quantum computer exists, and nothing in today's channel protects against that. No reviewed hybrid profile of Noise exists yet; `Noise_XXhfs_25519+MLKEM768_ChaChaPoly_SHA256` is an open working draft with no formal analysis ([libp2p/specs#727](https://github.com/libp2p/specs/pull/727)). The channel ships no draft and no second, TLS-based connection. The hybrid `KK` profile joins once its specification is finished and reviewed for production use, as one more profile in the same first frame, ahead of the classical two, on the same channel keys and frames; that move is a `docs/backlog.md` entry blocked on the specification.
   - **Either carrier.** The channel rides a WebRTC data channel straight between the device and the machine wherever the two can reach each other, and the relay otherwise ([ADR-008](./008-default-transports-and-relay-boundaries.md)). Both carry it byte for byte: the same first frame, the same `KK` handshake on the same channel keys and profiles, run by the same code on each host, and the same 10-minute rekey, so nothing above the carrier knows which one it is on. WebRTC's own DTLS always encrypts and cannot be turned off ([RFC 8827](https://www.rfc-editor.org/rfc/rfc8827) §6.5); the sealed channel inside it stays, so the rekey and the profile choice hold on both carriers and a flaw in either end's DTLS exposes no session byte. The data channel's DTLS fingerprint is trusted because the offer that names it travels inside the sealed channel, which only the paired keys open, and the `KK` handshake on the data channel then proves both ends against the chain as it does on the relay.
   - **The relay** sees the device id and machine id at connection, the channel version and the profile, frame sizes and times, and never a method, a name or a byte of a session; it learns that a channel moved onto the direct path only from its connection going quiet. It holds at most one live connection per machine key and, for each machine, one per device key (on the Workers relay on that machine's forwarding object, on the Compose relay in its one process).
   - **The implementation** on the machine is `snow`, built with its `ring-accelerated` feature, in `sidekicks-daemon`. On a device it is the channel package's own `KK`, written from Noise revision 34 on WebCrypto's X25519, AES-GCM, SHA-256 and HKDF with `@noble/ciphers` for ChaChaPoly, because each maintained Noise library takes its Diffie-Hellman as a synchronous call over the private key's bytes and so none can run on a non-extractable WebCrypto key; its key exchange is asynchronous: each handshake's ephemeral key is a fresh non-extractable WebCrypto key the page makes and drops after the handshake on every host, and the channel key's exchanges run in WebCrypto in the web client and natively in the iPhone's bridge, so that key never enters the page. [Plan-025](../plans/025-remote-control.md) Phase 3 records the libraries considered and the tests that hold it to `snow`.

5. **No other key classes.** There is no session-scoped ephemeral key, no signed key bundle, no first-claim store, no key package and no cap on recipients: a channel's keys belong to a connection. No token is minted for dispatching work to another machine, because a session never runs anywhere but the machine it was started on.

### Thesis — Why This Option

Every property the product needs from the channel is a property of two-party Noise: mutual authentication of known static keys (`KK`), forward secrecy per handshake, a published, formally analyzed construction with production precedent (WireGuard runs its `IK` sibling), and prologue binding for negotiation. The account's statement chain already names every key a machine may trust, so `KK` needs no directory, no key server and no bundle admission on the control plane: the machine's own refusal in the handshake protects the sessions. PASETO v4 removes algorithm confusion by having one algorithm per version, and one sign-in the service runs serves the desktop, the CLI and a machine with no desktop alike.

### Antithesis — The Strongest Case Against [T2]

The channel is classical: a party recording traffic today gets it all once a quantum computer exists, which a hybrid construction available now would prevent. The hybrid draft could be shipped as it stands, or a TLS 1.3 connection with a hybrid group could be opened beside the channel. A web client depends on WebCrypto's X25519, and the devices' end of the channel is the project's own `KK` code, with no library's users to find its bugs: only the test vectors and the interop test against `snow` guard it. And pinning keys with no escape hatch means a person who reinstalls a machine must remove and relink it.

### Synthesis — Why It Still Holds [T2]

An unreviewed hybrid draft is a construction no one has analyzed, which is what this decision refuses; a second, TLS-based connection doubles the surface and splits the trust record. The profile negotiation is built in from the first release, so the hybrid profile arrives as one more offered profile on the same keys and frames the day its specification is reviewed, and the docs state the classical limit plainly until then. The library constraint is a selection criterion, recorded in Plan-025 under rule 15. A reinstalled machine being refused is the property a pin exists for; the refusal names the fix.

## Alternatives Considered

### Option A: PASETO v4 with an authorization-code sign-in and DPoP, passkeys outside the desktop app, and `Noise_KK` per connection (Chosen)

- **What:** §Decision items 1 to 5.
- **Steel man:** Every cryptographic part is a published, reviewed protocol used in production; nothing is invented. One channel per device and machine carries every screen. Trust has one record, the account's chain, which each machine verifies itself.

### Option B: JWT (Rejected)

- **What:** Standard JWT with RS256 or ES256.
- **Why rejected:** Algorithm confusion attacks (`alg: none`, HMAC/RSA confusion) are a persistent class of vulnerability. PASETO v4 eliminates this by design.

### Option C: A session-scoped pairwise envelope with an MLS upgrade path (Rejected)

- **What:** Per-session ephemeral X25519 keys signed by long-term Ed25519 identity keys and admitted by the control plane as signed bundles, HKDF-derived pairwise keys with XChaCha20-Poly1305 per recipient, a permanent first-claim store for ephemeral keys, a cap on recipients, and MLS (RFC 9420) as a later group upgrade.
- **Why rejected:** A channel scoped to one session leaves every screen outside that session unreachable from another device. The construction is the product's own composition of primitives rather than a reviewed protocol. It needs a permanent control-plane store to enforce single use of client-chosen keys, and the iPhone's hardware keys cannot sign its Ed25519 bundles. With one person every channel has two ends, so MLS's group machinery and its promotion gates buy nothing.

### Option D: Signal Protocol (Rejected)

- **What:** The Double Ratchet for pairwise end-to-end encryption.
- **Why rejected:** `libsignal` requires native FFI rather than a WebAssembly-portable implementation, which conflicts with the desktop Electron and browser deployment targets.

### Option E: A hybrid post-quantum handshake now (Rejected)

- **What:** Ship the draft `Noise_XXhfs_25519+MLKEM768` profile, or open a TLS 1.3 connection with a hybrid key-exchange group beside the channel.
- **Why rejected:** The Noise hybrid is an open working draft with no formal analysis, and a second, TLS-based connection is a second transport with its own trust record. The profile negotiation takes the reviewed hybrid profile later with no new transport.

## Assumptions Audit [T2]

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | WebCrypto's X25519 and AES-GCM run from a non-extractable key in WebKit, so the web client's X25519 channel key and every handshake's ephemeral key stay non-extractable under the channel package's `KK`; the channel key, kept in IndexedDB wrapped under a non-extractable AES-GCM key and unwrapped at each load into a non-extractable X25519 key, still derives after a reload. | In a `capacitor://`-style WebKit page, X25519 `deriveBits` from a non-extractable WebCrypto key worked with both sides agreeing, and that page's AES-256-GCM output was byte-identical to Node's for the same key, nonce and data. WebCrypto's X25519 is present from Safari and iOS 18.4, Chrome 133 and Firefox 130 ([WebKit Features in Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)), and the iPhone app's floor is iOS 26. WebKit returns nothing for a stored non-extractable X25519 key while a stored AES-GCM key reads back (bugs.webkit.org 312279), so the key is stored wrapped. In WebKit 27.2 (Playwright 1.64.0's build) a stored non-extractable X25519 key read back as `null` after a reload, while the wrapped key unwrapped into a non-extractable X25519 key that derived the same secret as before the reload and refused `exportKey`, and a stored non-extractable P-256 signing key read back and signed; Plan-025 keeps that reload as a test. | The web client's channel key would have to be extractable, which the channel does not accept, so the web client could not open a channel. |
| 2 | A hybrid post-quantum Noise profile will be specified and reviewed for production use. | [libp2p/specs#727](https://github.com/libp2p/specs/pull/727) is an open working draft. | The channel stays classical for longer, and the docs keep saying so; nothing else changes. |
| 3 | PASETO v4 can be produced and verified by the maintained `pasetors` crate, `v4.local` and `v4.public` alike, in the daemon and in the control plane's Worker. | §PASETO v4 Implementation Library. | We would fork or migrate to another token format, re-issuing every token. |
| 4 | A machine can hold its DPoP key and refresh token unattended. | Each is its own item in the operating system's credential store, which opens unattended under the person's login ([ADR-020](./020-cli-identity-key-storage-custody.md)). | Sign-in would have to be repeated at each start where the store cannot be read. |

## Failure Mode Analysis [T2]

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| A flaw is found in a channel end's Noise code | Low | High | Security advisories and dependency scanning in CI for `snow` and `@noble/ciphers`; the channel package's `KK` vectors and its interop test against `snow` | `snow` on the machine is replaced with a fixed release or another implementation of the same profile; the channel package's own `KK` on the devices is fixed in place and passes its vectors and the interop test again, and a flaw in `@noble/ciphers` takes its fixed release. The protocol itself does not change. |
| A large enough quantum computer arrives before the hybrid profile is reviewed | Low | High | Public cryptanalysis news; the backlog entry's blocker | Recorded traffic is exposed; the docs already state it. Ship the hybrid profile the day it is reviewed. |
| A PASETO library bug (key handling, `v4.local` decryption) | Low | High | The pull request's review, fuzzing of token parsing | Take the fixed release; the official PASETO test vectors run against every token `pasetors` makes. |
| A stolen device key is used from a second place | Med | Med | The relay holds, for each machine, one live connection per device key (on the Workers relay on that machine's forwarding object, on the Compose relay in its one process): the newest wins, and a key that keeps displacing itself is flagged | The device's card says so, and the person revokes it; every machine refuses it from the next chain head. |
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

- When the hybrid profile's specification is finished and reviewed; the backlog entry tracks it.

## Decision Validation [T2]

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Frames the relay can read | None | A test that holds the relay's whole view and fails to read a payload (Plan-025 Phase 3) | Before the first release carrying Remote Control |
| Frames the direct path's packets reveal | None | A test that holds every UDP payload of the direct path and reads no frame (Plan-025 Phase 9) | Before the first release carrying Remote Control |
| An altered profile offer | Fails the handshake on both ends | Plan-025 Phase 3 test | Before the first release carrying Remote Control |
| The channel package's `KK` | Passes snow's and cacophony's four `KK` vectors and completes both profiles against `snow` | Plan-025 Phase 3 tests | Before the first release carrying Remote Control |
| Token-related vulnerabilities affecting our auth flows | 0 exploitable reports | The pull request's review plus dependency scanning | At each release |

## PASETO v4 Implementation Library

PASETO v4 tokens in §Decision item 2 are produced and verified with the maintained [`pasetors`](https://crates.io/crates/pasetors) 0.8.1 crate with its default features (`std`, `v4`, `paserk`), linked into the daemon and the control plane's Worker; the project wraps it in no package of its own. It carries the token framing, the claim checks and the encoding, and builds in both `v4.public` (Ed25519) and `v4.local`. `v4.local` is an **encrypt-then-MAC** construction (XChaCha20 stream encryption followed by BLAKE2b-MAC over the PAE), **not** XChaCha20-Poly1305 AEAD — this matches the PASETO v4 spec ([Version4.md §v4.local](https://github.com/paseto-standard/paseto-spec/blob/master/docs/01-Protocol-Versions/Version4.md#v4local)), which deliberately replaces Poly1305 with keyed BLAKE2b.

The crate verifies with `ed25519-compact` 2.6.0, which refuses a small-order public key before the signature check (`WeakPublicKey`), so a forgery that a lax Ed25519 verify accepts is refused. On the Worker, the crate adds `time` with its `wasm-bindgen` feature, because `pasetors`' claim checks read `OffsetDateTime::now_utc()`, which panics on `wasm32-unknown-unknown` without it. `pasetors` was weighed against `rusty_paseto` and proven natively and in workerd: every official v4 vector (the crate's own `v4.json` holds them), the forged small-order key refused, and fresh tokens minted on both.

## Identity Key Storage

- **A machine** keeps its identity key, its channel key, its DPoP key and every other daemon secret each as its own item, which opens unattended at every start: in the operating system's credential store on macOS and Windows, the login keychain and Credential Manager; on Linux in one file readable by this account alone, each item sealed through systemd's credential service where it can seal and plain where not; and in the same file, plain, on a Mac from its logged-out service's takeover until `sidekicks daemon uninstall`, even after that service is turned off in Login Items & Extensions — as [ADR-020](./020-cli-identity-key-storage-custody.md) records. The CLI never holds a private key: it asks the daemon over the local socket. A key is never replaced silently: the machine's key changes only when a removed machine is linked again under its same machine id, and every device moves its pin only on the new `machine.added` of that rejoin; from then on a statement the old key signs is refused, and the old key is never trusted again.
- **A device** makes its identity key on the device and never exports it: P-256 in the iPhone's Secure Enclave and a non-extractable WebCrypto key in the web client ([Spec-027 §The encryption envelope](../specs/027-remote-control.md#the-encryption-envelope), [Spec-028](../specs/028-connect-an-ios-app-and-drive-control.md)).
- No key is derived from a passkey.

## Related Domain Docs

- [Trust And Identity](../domain/trust-and-identity.md) — the domain model for identity material, the statement chain, fingerprints and the trust-state lifecycle that this record's primitives implement.

## References

- [ADR-007: Device Trust and Permission Model](./007-device-trust-and-permission-model.md)
- [ADR-020: Machine Identity Key Custody](./020-cli-identity-key-storage-custody.md)
- [Spec-027: Remote Control](../specs/027-remote-control.md)
- [The Noise Protocol Framework](https://noiseprotocol.org/noise.html) — the `KK` pattern, the prologue (§6) and the transport.
- [Noise Explorer](https://noiseexplorer.com/) — formal models of the Noise handshake patterns.
- [WireGuard protocol](https://www.wireguard.com/protocol/) — production precedent for a Noise handshake (`IK`).
- [libp2p/specs#727](https://github.com/libp2p/specs/pull/727) — the open working draft of a hybrid post-quantum Noise profile.
- [PASETO Specification](https://paseto.io/)
- [RFC 8252 — OAuth 2.0 for Native Apps](https://www.rfc-editor.org/rfc/rfc8252)
- [RFC 7636 — Proof Key for Code Exchange](https://www.rfc-editor.org/rfc/rfc7636)
- [RFC 9126 — OAuth 2.0 Pushed Authorization Requests](https://www.rfc-editor.org/rfc/rfc9126)
- [RFC 9207 — OAuth 2.0 Authorization Server Issuer Identification](https://www.rfc-editor.org/rfc/rfc9207)
- [RFC 7009 — OAuth 2.0 Token Revocation](https://www.rfc-editor.org/rfc/rfc7009)
- [RFC 10027](https://www.rfc-editor.org/rfc/rfc10027) — §6.1.17, the user-transferred code the command line takes where no browser can reach the machine.
- [RFC 9449 — OAuth 2.0 Demonstrating Proof of Possession (DPoP)](https://www.rfc-editor.org/rfc/rfc9449)
- [`pasetors` on crates.io](https://crates.io/crates/pasetors) — the token library.
