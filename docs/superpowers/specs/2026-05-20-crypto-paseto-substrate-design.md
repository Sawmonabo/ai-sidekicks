# `@ai-sidekicks/crypto-paseto` substrate — design

| Field            | Value                                                                |
| ---------------- | -------------------------------------------------------------------- |
| Status           | draft                                                                |
| Drafted          | 2026-05-20                                                           |
| Owner            | user (a.sawmon@gmail.com)                                            |
| Implementer      | Claude Opus 4.7                                                      |
| Brainstormed via | `superpowers:brainstorming` skill (terminal step is `writing-plans`) |

## 1. Purpose & non-goals

### 1.1 Purpose

This document defines the design contract for the `@ai-sidekicks/crypto-paseto` workspace package: its public interfaces, cryptographic invariants, threat model, and the seams it preserves for downstream consumers ([Plan-018](../../plans/018-identity-and-participant-state.md) Tier 5 refresh-token persistence; [Plan-025](../../plans/025-self-hostable-node-relay.md) Tier 7 relay-server token verification).

The package ships PASETO v4.public and v4.local primitives plus a PAE helper and an in-memory KeyRing — together they form the cryptographic substrate that V1 authentication tracks depend on.

### 1.2 Non-goals (carve-out boundary)

This design spec deliberately does **not** cover:

- **Relay-server wire protocol** — owned by [Spec-008](../../specs/008-control-plane-relay-and-session-join.md) (v2 wire protocol) + [Spec-025](../../specs/025-self-hostable-node-relay.md) (Node.js deployment), implemented in Plan-025 Tier 7.
- **Persistence backend for KeyRing** — owned by [Plan-018](../../plans/018-identity-and-participant-state.md) Tier 5. The constructor seam (§8) is the integration surface; substance lives downstream.
- **Operator-facing config and deployment posture** — owned by [Spec-025](../../specs/025-self-hostable-node-relay.md) (Docker / Caddy / reverse-proxy topology).
- **End-user-facing token issuance flows** — owned by [Plan-002](../../plans/002-invite-membership-and-presence.md) (invite tokens) and [Plan-018](../../plans/018-identity-and-participant-state.md) (refresh tokens).

### 1.3 Why `substrate_exempt`

[Plan-025](../../plans/025-self-hostable-node-relay.md) Tier 1 Partial Phase 1 (the implementation phase this design governs) is admitted under the readiness-audit runbook's [§Per-Phase Audit Semantics](../../operations/plan-implementation-readiness-audit-runbook.md) `substrate_exempt` predicate: `spec_coverage: []` because Spec-025 governs network behavior (the relay surface) — not package-level primitives. The plan-readiness audit gates G1–G6 do not apply to the implementation PR; [ADR-010](../../decisions/010-paseto-webauthn-mls-auth.md) acceptance criteria apply at code-review time.

## 2. Governing contracts

| Source | Role |
| --- | --- |
| [ADR-010](../../decisions/010-paseto-webauthn-mls-auth.md):129–136 | Authoritative contract: in-house lib mandate + v4.public + v4.local dual coverage + audited deps (`@noble/curves`, `@noble/ciphers`, `@noble/hashes`) |
| [ADR-010](../../decisions/010-paseto-webauthn-mls-auth.md):29 | Plan-018 v4.local dependency declared |
| PASETO Spec — Version 4 | Primary source for both primitives — https://github.com/paseto-standard/paseto-spec/blob/master/docs/01-Protocol-Versions/Version4.md |
| PASETO Spec — Common (PAE) | Primary source for Pre-Authentication Encoding — https://github.com/paseto-standard/paseto-spec/blob/master/docs/01-Protocol-Versions/Common.md |
| PASETO Test Vectors v4 | Release-gate vector source — https://github.com/paseto-standard/test-vectors/blob/master/v4.json |
| [Spec-025](../../specs/025-self-hostable-node-relay.md) | Context only; `spec_coverage: []` — Spec-025 governs the relay-server surface, not the package primitives |
| [Plan-025](../../plans/025-self-hostable-node-relay.md) §Target Areas, §Tier 1 Partial PR Sequence | Owning plan; carves Phase 1 substrate out from Tier 7 relay implementation |

## 3. Public surface

The package's exports are flat under `src/index.ts`, mirroring the `packages/contracts/` precedent.

### 3.1 v4.public

```ts
interface V4PublicKeyPair {
  readonly publicKey: Uint8Array; // 32 bytes
  readonly secretKey: Uint8Array; // 32 bytes
}

function generateV4PublicKeyPair(): V4PublicKeyPair;

function signV4Public(
  payload: Uint8Array,
  secretKey: Uint8Array,
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): string;

function verifyV4Public(
  token: string,
  publicKey: Uint8Array,
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): Uint8Array; // returns the verified payload bytes
```

### 3.2 v4.local

```ts
function encryptV4Local(
  payload: Uint8Array,
  key: Uint8Array, // 32 bytes
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): string;

function decryptV4Local(
  token: string,
  key: Uint8Array,
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): Uint8Array; // returns the decrypted payload bytes
```

### 3.3 KeyRing

```ts
interface KeyRingEntry {
  readonly id: string; // e.g., "k_2026_05"
  readonly key: Uint8Array; // 32 bytes
  readonly createdAt: Date;
  readonly retiredAt?: Date; // undefined when active
}

class KeyRing {
  constructor(entries: readonly KeyRingEntry[]);
  active(): KeyRingEntry; // throws InvalidKeyError if no active entry
  byId(id: string): KeyRingEntry | undefined;
  rotate(next: KeyRingEntry): KeyRing; // immutable; returns new instance
}
```

Constructor invariants (enforced at construction time):

1. **At least one active entry** — at least one entry in `entries` must have `retiredAt: undefined`; construction with zero active entries throws `InvalidKeyError`.
2. **At most one active entry** — construction with more than one `retiredAt: undefined` entry throws `InvalidKeyError`.

Together: exactly one active entry per `KeyRing` instance.

`rotate(next)` returns a new `KeyRing` where the prior active entry has been marked `retiredAt: <rotation timestamp>` and `next` is the new active. The pre-rotation instance is unchanged.

### 3.4 PAE (low-level)

```ts
function pae(pieces: readonly Uint8Array[]): Uint8Array;
```

Exposed so callers building extensions (custom token shapes, future PASETO versions) can use the same canonical PAE implementation. Not intended for typical application use.

### 3.5 Error taxonomy

```ts
class InvalidTokenError extends Error  // malformed token, base64url decode failure, header mismatch, footer mismatch
class InvalidKeyError   extends Error  // wrong-length key (≠ 32 bytes), wrong key family, KeyRing invariant violation
class MacMismatchError  extends InvalidTokenError  // v4.local MAC verify failed
```

`MacMismatchError extends InvalidTokenError` so consumers can `catch (e) { if (e instanceof InvalidTokenError) ... }` to cover all token-verification failures uniformly.

Error messages carry **no key, signature, plaintext, or ciphertext bytes** — only structural information ("MAC mismatch", "invalid v4.local header", "footer length mismatch"). See §5.

### 3.6 Internal (not exported)

```ts
// src/internal/v4-local-deterministic.ts (NOT re-exported via src/index.ts)
function encryptV4LocalDeterministic(
  payload: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array, // 32 bytes — caller-provided
  footer?: Uint8Array,
  implicitAssertion?: Uint8Array,
): string;
```

Test-only seam (see §7).

## 4. Cryptographic algorithms

All three sub-blocks below trace to primary sources; algorithm definitions are exact quotes from PASETO Version4.md and Common.md.

### 4.1 PAE (Pre-Authentication Encoding)

Per `paseto-spec/docs/01-Protocol-Versions/Common.md` §Authentication Padding:

```
PAE(pieces) = LE64(len(pieces))
            || LE64(len(pieces[0])) || pieces[0]
            || LE64(len(pieces[1])) || pieces[1]
            || ...
```

Where `LE64(n)` is a 64-bit little-endian unsigned integer **with the high bit (bit 63) cleared** (clears the most-significant bit of the most-significant byte). This length-prefixed concatenation is what gets fed into the signing and authentication primitives — it defends against canonicalization attacks (two different piece-sets producing the same byte stream).

### 4.2 v4.public

**Algorithm**: Ed25519 PureEdDSA (RFC 8032). No pre-hash.

**Token shape**:

```
v4.public.<b64url(payload || sig)>                       (no footer)
v4.public.<b64url(payload || sig)>.<b64url(footer)>       (with footer)
```

Where `sig = Ed25519.sign(PAE([header, payload, footer, implicitAssertion]), secretKey)`, `header = "v4.public."`, and `footer` / `implicitAssertion` follow the canonicalization rules in §6.

**Noble 2.x call shape** (load-bearing — message-first argument order):

```ts
import { ed25519 } from "@noble/curves/ed25519.js";
ed25519.sign(message, secretKey);
ed25519.verify(signature, message, publicKey);
```

Reversing the argument order is a silent correctness bug (signatures verify for the wrong message). Implementation must follow message-first.

### 4.3 v4.local

**Algorithm**: XChaCha20 stream cipher + BLAKE2b-MAC over PAE. **Not AEAD.** This is the doc-drift item: Plan-025 §Implementation Steps 2 says "XChaCha20-Poly1305 AEAD"; the PASETO v4 spec §v4.local actually uses XChaCha20 + BLAKE2b-MAC. Implementation follows the primary spec.

**Encrypt flow** (per `paseto-spec/docs/01-Protocol-Versions/Version4.md` §v4.local Encrypt):

```
                 ┌─────────────┐
key (k, 32B) ───▶│  derive Ek  │── n2 (24B) ─┐  XChaCha20 nonce
                 │ via BLAKE2b │── Ek (32B) ─┤  XChaCha20 key
                 └─────────────┘             │
                        ▲                    ▼
                        │           ┌─────────────────┐
n (random 32B) ─────────┴───────────▶│  XChaCha20(Ek,  │
                        │            │  n2, payload)   │── c (ciphertext)
                        │            └─────────────────┘
                        ▼                       │
                 ┌─────────────┐                │
key (k) ────────▶│  derive Ak  │── Ak (32B) ────┼──────┐
                 │ via BLAKE2b │                │      │
                 └─────────────┘                ▼      ▼
                                       ┌────────────────────────┐
                                       │ BLAKE2b-MAC(Ak,         │
                                       │  PAE([h, n, c, f, i]))  │── t (32B tag)
                                       └────────────────────────┘

token = "v4.local." || b64url(n || c || t)
      [ || "." || b64url(f)  if footer present ]
```

Key derivation expanded:

- `tmp = BLAKE2b(key=k, msg="paseto-encryption-key" || n, length=56)`
  - `Ek = tmp[0..32]` — XChaCha20 key
  - `n2 = tmp[32..56]` — 24-byte XChaCha20 nonce
- `Ak = BLAKE2b(key=k, msg="paseto-auth-key-for-aead" || n, length=32)` — BLAKE2b MAC key

**Decrypt** is the inverse with **constant-time MAC compare before decryption**:

1. Parse `n`, `c`, `t` from the b64url segment.
2. Derive `Ek`, `n2`, `Ak` as above.
3. `t' = BLAKE2b-MAC(Ak, PAE([h, n, c, f, i]))`.
4. **If `!equalBytes(t, t')` throw `MacMismatchError`** — exits before any decryption.
5. `m = XChaCha20(Ek, n2, c)` — recover plaintext.

The MAC-before-decrypt ordering (step 4 before step 5) is the load-bearing invariant: an attacker who can submit ciphertext but cannot forge a MAC never reaches the cipher.

## 5. Threat model & invariants

### 5.1 Adversary model

**In scope** (the package defends against):

- **Network attacker** — observes and tampers with tokens in transit. The primitive guarantees integrity (signature for v4.public; MAC for v4.local) and confidentiality (XChaCha20 for v4.local).
- **Log-reader attacker** — has read access to service logs. The primitive guarantees no key, signature, plaintext, ciphertext, or other secret-bearing bytes leak into error messages.
- **Time-side-channel attacker** — measures comparison timings on signature or MAC bytes. The primitive uses constant-time comparison everywhere a secret-bearing value is involved.

**Out of scope** (these are other layers' jobs):

- **Local-process attacker with arbitrary memory read** — OS process boundaries and the future sidecar separation own this. Cryptographic primitives operating in the same address space as their callers cannot defend against this.
- **Replay attack** (same token submitted twice within validity window) — PASETO itself does not claim replay defense; the token carries no unique-ID required for "have I seen this before" stateful checks. The relay ([Spec-025](../../specs/025-self-hostable-node-relay.md) / Plan-025 Tier 7) is the correct layer.
- **Compromised dependency** — supply-chain posture (§9) covers this with pinning, `minimumReleaseAge`, and `blockExoticSubdeps`; it is not a primitive-design concern.

### 5.2 Invariants the package guarantees

| # | Invariant | Mechanism |
| --- | --- | --- |
| I1 | Constant-time MAC + signature comparison | `equalBytes` from `@noble/hashes/utils.js`; never `===`; never `Buffer.compare` on secret-bearing bytes |
| I2 | MAC verified before any decryption attempt | v4.local decrypt step 4 gates step 5; failure throws and exits |
| I3 | Nonce freshness | Every `encryptV4Local` generates fresh 32 random bytes via `randomBytes`; nonces never reused; never logged |
| I4 | No secrets in error messages | Error classes carry only structural info — no key, sig, plaintext, ciphertext bytes |
| I5 | Key material typed as `Uint8Array` only | No `string` type aliases for keys — keys cannot accidentally land in JSON logs (`JSON.stringify(Uint8Array)` → `{}`) |
| I6 | No conditional branching on secret-key bytes | Code paths involving secret material are unconditional or branch only on structural (length, header) bytes |

### 5.3 Threat → invariant mapping

| Adversary capability | Attack vector | Defending invariant(s) |
| --- | --- | --- |
| Network attacker | Forge v4.public token | Ed25519 signature verification (I1) |
| Network attacker | Tamper with v4.local ciphertext | MAC verify before decrypt (I1 + I2) |
| Network attacker | Force nonce reuse / collision | Fresh 32-byte random nonce per encrypt (I3) — collision probability 2^-256 per call; nonce-reuse with same key would break XChaCha20 confidentiality |
| Log-reader | Lift keys from error logs | No secrets in errors (I4); `Uint8Array` typing (I5) |
| Time side-channel | Distinguish MAC-mismatch position | Constant-time `equalBytes` (I1) |
| Time side-channel | Time-distinguish key-byte values | No branching on secret-key bytes (I6) |

## 6. Footer / implicit-assertion semantics

PASETO's footer and implicit-assertion fields are both optional but distinct: footer is encoded into the token and visible to anyone who has the token bytes; implicit assertion is a side-channel input to PAE that must be reconstructed by the verifier from out-of-band context (e.g., a known session ID).

Upstream `v4.json` test vectors ship `""` (empty string) for unused footer and implicit-assertion. This spec ratifies the canonicalization rule:

> **`undefined` ≡ `new Uint8Array(0)` at the public API boundary.** Internal code paths see only the canonical `Uint8Array` form.

**Footer canonicalization**:

- Either form produces a token with **no footer suffix** (no trailing `.b64url(footer)` segment in the token string).
- On verify/decrypt with non-empty expected footer: if the token has no footer segment, throw `InvalidTokenError("footer-expected-but-absent")`.
- On verify/decrypt with empty expected footer: if the token has a footer segment, throw `InvalidTokenError("footer-absent-but-present")`.
- Strict-equality check: token footer must byte-exactly equal expected footer.

**Implicit-assertion canonicalization**:

- Either form is consumed in PAE as a zero-byte input — PAE still encodes a length-zero piece (per Common.md PAE spec); it is **not** skipped or omitted.

This rule means callers don't have to choose between two API shapes for the empty case — the package treats both the same way.

## 7. Test-only deterministic-nonce seam

PASETO v4.local encrypt is non-deterministic by design (fresh 32-byte nonce per call). RFC vector encrypt round-trips require byte-exact token reproduction — which needs the recorded `nonce` field from the vector fed back into the encrypt path.

The package addresses this with an internal-only deterministic variant:

- **File**: `packages/crypto-paseto/src/internal/v4-local-deterministic.ts`
- **Export**: `encryptV4LocalDeterministic(payload, key, nonce, footer?, ia?): string`
- **Scope guard**: not re-exported from `src/index.ts`. Tests in `src/__tests__/` import via relative path (`../internal/v4-local-deterministic.js`), not via the `@ai-sidekicks/crypto-paseto` workspace alias.
- **Production path**: `encryptV4Local` internally calls `encryptV4LocalDeterministic` with `randomBytes(32)`. The deterministic variant exercises the full algorithm (PAE + BLAKE2b key derivation + XChaCha20 cipher + BLAKE2b MAC) — tests bypass only the random source.

**Why this pattern**: production callers should not be able to provide their own nonce — accidental nonce reuse with the same key compromises XChaCha20's confidentiality guarantee. By keeping the deterministic variant out of the public barrel and using deep-relative imports only in tests, the production API surface is nonce-safe-by-construction.

**Precedent**: this pattern appears in mature PASETO libraries — `paseto-php`, `paseto-go`, and `panva/paseto` all gate the deterministic variant behind a test-only path for the same reason.

## 8. KeyRing scope + persistence seam

The Phase 1 KeyRing is **in-memory only**. No file I/O, no database access, no on-disk persistence at this layer.

### 8.1 Why in-memory only

[Cross-plan dependencies §5](../../architecture/cross-plan-dependencies.md) names [Plan-018](../../plans/018-identity-and-participant-state.md) Tier 5 as the owner of identity-state persistence (the table that stores `KeyRingEntry` rows). The substrate must not pre-empt that storage decision — different deployment targets (SQLite for self-host, Postgres for hosted) need different schemas, and Plan-018 is the canonical place to make that call.

### 8.2 The persistence seam

```ts
class KeyRing {
  constructor(entries: readonly KeyRingEntry[]);
  // ...
}
```

The constructor accepts a pre-loaded array of entries. Plan-018 Tier 5 will:

1. Read `KeyRingEntry` rows from its storage backend (whatever schema it lands on).
2. Construct a `KeyRing` instance: `new KeyRing(loadedEntries)`.
3. Hand the instance to whatever component owns access-token verification.

The substrate doesn't know where the entries came from — it gets a `readonly KeyRingEntry[]` and applies its invariants. Plan-018 can change its storage substrate (e.g., add encryption-at-rest, switch backends) without touching `crypto-paseto`.

### 8.3 Rotation semantics

`rotate(next)` returns a **new** `KeyRing` instance:

- The prior active entry has its `retiredAt` field set to the rotation timestamp in the new instance.
- The `next` entry becomes the new active entry.
- The pre-rotation instance is unchanged — call sites holding a reference to the old `KeyRing` continue to see the old key as active.

This immutability supports two patterns Plan-018 will rely on:

1. **Rollback**: if rotation needs to be reverted (e.g., the new key has a corruption), the application can swap back to the old `KeyRing` instance.
2. **Concurrent reads**: in-flight verifications that started with the old `KeyRing` complete against the old active key; new verifications use the new instance. No shared mutable state to race on.

**Usage note (rotation trap)**: callers must **reassign** the variable holding the `KeyRing` after rotation — `keyRing = keyRing.rotate(next)`. Calling `rotate()` and discarding its return value (e.g., `keyRing.rotate(next)` as a statement) silently keeps the old key active because the existing instance is unchanged. This is by design (supports the rollback and concurrent-read patterns above) but is a usage trap for callers who assume mutation semantics. Plan-018 Tier 5's integration must hold the `KeyRing` instance behind an indirection (atomic ref, module-scope binding) that supports atomic swap.

`active()` always returns the single entry with `retiredAt: undefined`; per the constructor invariants (§3.3) there is always exactly one such entry. `byId(id)` returns retired entries too — used for verifying tokens that were signed with a now-retired key but are still within their token-validity window.

## 9. Dependency posture

### 9.1 Pinned versions

| Package          | Version | Purpose                              |
| ---------------- | ------- | ------------------------------------ |
| `@noble/curves`  | `^2`    | Ed25519 (v4.public sign/verify)      |
| `@noble/ciphers` | `^2`    | XChaCha20 stream cipher (v4.local)   |
| `@noble/hashes`  | `^2`    | BLAKE2b, `equalBytes`, `randomBytes` |

No `paseto` / `paseto-js` / any upstream PASETO library is consumed. The package implements the protocol directly against the noble primitives — this satisfies the ADR-010:129–136 in-house-lib mandate.

### 9.2 Audit posture rationale

Noble 2.x is self-audited (Paul Miller, April 2026) and actively maintained, but lacks the external Cure53 / Kudelski audit that the 1.x line received. This is a user-confirmed override; the implementation PR description must call this out for reviewer acknowledgement. Re-evaluation milestone: **V1.1** if/when 2.x gets external audit.

### 9.3 Import discipline

The following imports are **load-bearing** — using the wrong symbol breaks the implementation in subtle ways:

| Symbol | Source | Why it matters |
| --- | --- | --- |
| `xchacha20` | `@noble/ciphers/chacha.js` | **Stream cipher**; correct for PASETO v4.local |
| ❌ `xchacha20poly1305` | `@noble/ciphers/chacha.js` | **AEAD**; wrong for v4.local; this is the Plan-025 doc-drift item |
| `blake2b` | `@noble/hashes/blake2.js` | Accepts `{ key, dkLen }` options object; used for key derivation and MAC |
| `equalBytes` | `@noble/hashes/utils.js` | Constant-time byte comparison; load-bearing for I1 |
| `randomBytes` | `@noble/hashes/utils.js` | Source of v4.local nonce entropy; load-bearing for I3 |
| `ed25519` | `@noble/curves/ed25519.js` | Message-first call order; reversing is a silent correctness bug |

### 9.4 Supply-chain hardening (inherited)

The workspace's `pnpm-workspace.yaml` enforces:

- `minimumReleaseAge: 1440` (24h) — newly published versions are not installable until 24 hours after publish, giving time for malicious-package detection.
- `blockExoticSubdeps: true` — transitive deps must come from approved registries.

These apply repo-wide and cover `@noble/*` automatically.

## 10. Release gate: RFC vector conformance

[ADR-010](../../decisions/010-paseto-webauthn-mls-auth.md):129–136 includes the acceptance criterion **"RFC conformance gating release"**. This package satisfies that criterion mechanically through two test suites that exercise the upstream PASETO v4 vector set.

### 10.1 Vendored fixture

- **Path**: `src/__tests__/__fixtures__/v4.json`
- **Source**: `https://github.com/paseto-standard/test-vectors/blob/master/v4.json`
- **Provenance file**: `src/__tests__/__fixtures__/PROVENANCE.md` records:
  - Source URL
  - Upstream commit SHA at vendor time
  - Retrieval date
  - `sha256` of the JSON file

Vendoring is hermetic — the test suite makes no network calls. Updates to the upstream vectors are handled by follow-up PRs that bump the commit SHA in `PROVENANCE.md`; the diff is auditable.

### 10.2 Coverage shape

Two test files, one shared fixture:

- `src/__tests__/rfc-vectors-v4-public.test.ts` — filters `name.startsWith("4-S-")`
- `src/__tests__/rfc-vectors-v4-local.test.ts` — filters `name.startsWith("4-E-")`

Each test file asserts:

| Vector class | Positive (`expect-fail: false`) | Negative (`expect-fail: true`) |
| --- | --- | --- |
| v4.public | `verifyV4Public` returns expected payload bytes; sign round-trip produces byte-exact token (Ed25519 is deterministic) | `verifyV4Public` throws expected error class |
| v4.local | `decryptV4Local` returns expected payload bytes; encrypt round-trip via the test-only deterministic seam (§7) feeds the vector's `nonce` and produces byte-exact token | `decryptV4Local` throws expected error class |

### 10.3 Non-zero-count guard

Each test file's final assertion: `expect(vectorsProcessed).toBeGreaterThan(0)`. This defends against an accidentally-empty filter (e.g., a future schema change that renames the `4-S-` / `4-E-` prefix) causing the suite to silently pass with zero coverage.

## 11. Design decisions ratified

The following six decisions were settled during planning and are recorded here for downstream readers:

| Question | Decision | Justification |
| --- | --- | --- |
| RFC vector ingestion | Vendor `v4.json` under `src/__tests__/__fixtures__/` with `PROVENANCE.md` | Hermetic CI; no network in test runs; auditable diff on upstream updates |
| KeyRing scope at Tier 1 Partial | In-memory only; persistence injection point preserved (constructor seam, §8) | Persistence belongs to Plan-018 Tier 5 per cross-plan-deps §5; substrate must not pre-empt storage decisions |
| Noble pinning | `@noble/curves@^2`, `@noble/ciphers@^2`, `@noble/hashes@^2` | User override of "audited 1.x" recommendation; Paul Miller self-audit (April 2026) + active maintenance; re-evaluate at V1.1 |
| Public surface | Flat `src/index.ts` barrel | Mirrors `packages/contracts/src/index.ts` precedent |
| Vector file shape | Single `v4.json` with name-prefix filter (`4-S-*` → v4.public, `4-E-*` → v4.local) | Matches upstream `paseto-standard/test-vectors` schema; one source of truth |
| Test directory | `src/__tests__/` | Matches workspace convention used by `packages/contracts/` and root `vitest.config.ts` include pattern |

## 12. Risks

| Risk | Mitigation |
| --- | --- |
| Noble 2.x self-audit only (vs. externally Cure53/Kudelski-audited 1.x line) | User-confirmed override. Implementation PR description must call this out so reviewer acks. Re-evaluate at V1.1 if/when 2.x gets external audit. |
| Plan-025 narrative says XChaCha20-Poly1305 AEAD; actual spec is XChaCha20 + BLAKE2b-MAC | Implementation follows primary spec (paseto-standard/paseto-spec §v4.local). File `BL-NNN` post-merge to amend Plan-025 doc. |
| Vendored vector file lifecycle (upstream `paseto-standard/test-vectors` updates) | Pinned to specific commit SHA in `PROVENANCE.md`. Updates handled by follow-up PRs; diff is auditable. |
| Constant-time discipline in TypeScript (compiler doesn't enforce) | Use `@noble/hashes/utils.js` `equalBytes` for MAC/signature compares; never `===` or `Buffer.compare` on secret material. ESLint custom rule could enforce in future (out of scope for this substrate). |
| Supply-chain on `@noble/*` | Pinned to `^2`; `pnpm-workspace.yaml` has `minimumReleaseAge: 1440` (24h) + `blockExoticSubdeps: true`. SBOM coverage already in repo CI. |
| Key material in test fixtures triggers gitleaks | Documented as test-only via `PROVENANCE.md`; gitleaks allow-list scoped narrowly to `packages/crypto-paseto/src/__tests__/__fixtures__/v4.json`. |
| KeyRing persistence pre-empting Plan-018 Tier 5 | In-memory only; constructor accepts pre-loaded entries — no DB/file I/O at this layer. |
| Test vectors might assume PASETO 2.x library behavior incompatible with noble 2.x | Run smoke encrypt/decrypt before vendoring fixtures; if any vector diverges from noble output, surface as `BL-NNN` before merge. |

## 13. References

### Primary sources

- PASETO Spec — Version 4: https://github.com/paseto-standard/paseto-spec/blob/master/docs/01-Protocol-Versions/Version4.md
- PASETO Spec — Common (PAE): https://github.com/paseto-standard/paseto-spec/blob/master/docs/01-Protocol-Versions/Common.md
- PASETO Test Vectors v4: https://github.com/paseto-standard/test-vectors/blob/master/v4.json
- `@noble/curves` README (ed25519): https://github.com/paulmillr/noble-curves#readme
- `@noble/ciphers` README (xchacha20): https://github.com/paulmillr/noble-ciphers#readme
- `@noble/hashes` README (blake2b, equalBytes): https://github.com/paulmillr/noble-hashes#readme

### Governing repo docs

- [ADR-010: PASETO + WebAuthn + MLS Auth](../../decisions/010-paseto-webauthn-mls-auth.md) — lines 29, 129–136
- [Plan-025: Self-Hostable Node Relay](../../plans/025-self-hostable-node-relay.md) — §Scope, §Target Areas, §Tier 1 Partial PR Sequence
- [Spec-025: Self-Hostable Node Relay](../../specs/025-self-hostable-node-relay.md) — context only (no Phase 1 ACs; `spec_coverage: []`)
- [Cross-plan dependencies](../../architecture/cross-plan-dependencies.md) — §5 Tier 1 row + Plan-025 Substrate-vs-Namespace Carve-Out
- [Plan-implementation readiness-audit runbook](../../operations/plan-implementation-readiness-audit-runbook.md) — §Per-Phase Audit Semantics
- [CONTRIBUTING.md](../../../CONTRIBUTING.md) — GitFlow-lite, Conventional Branch, Conventional Commits
- [AGENTS.md](../../../AGENTS.md) — primary-source citation discipline
- `packages/contracts/` (PR #8) — precedent workspace-package shape
