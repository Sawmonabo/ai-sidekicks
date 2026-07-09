# Spec-014: Artifacts Files And Attachments

| Field | Value |
| --- | --- |
| **Status** | `review` (flipped from `approved` 2026-07-08: the §Cross-Node Artifact Relay (V1) amendment adds a new contract surface — relay methods, wire fields, quota/TTL parameters, erasure-closure row — so the spec re-earns `approved` through review, per the campaign-amendment precedent) |
| **NNN** | `014` |
| **Slug** | `artifacts-files-and-attachments` |
| **Date** | `2026-04-14` (amended 2026-07-08 — cross-node artifact relay pulled into V1 per the [ADR-015 amendment](../decisions/015-v1-feature-scope-definition.md#amendment-2026-07-08-v11-deferred-features-3--2-cross-node-shared-artifacts-pulled-into-v1); new §Cross-Node Artifact Relay (V1)) |
| **Author(s)** | `Codex` |
| **Depends On** | [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md), [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md), [Data Architecture](../architecture/data-architecture.md) |
| **Implementation Plan** | [Plan-014: Artifacts Files And Attachments](../plans/014-artifacts-files-and-attachments.md) |

## Purpose

Define the canonical handling of artifacts, file attachments, and immutable output payloads.

## Scope

This spec covers artifact types, attachment ingestion, storage expectations, manifests, visibility, and the cross-node artifact relay (payload availability across nodes, including while the publishing node is offline).

## Non-Goals

- Full UI preview rules
- Notification behavior for new artifacts
- Remote object-store implementation details

## Domain Dependencies

- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)
- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)

## Architectural Dependencies

- [Data Architecture](../architecture/data-architecture.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [ADR-004: SQLite Local State And Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)

## Required Behavior

- The system must support immutable artifact publication with durable manifests.
- Supported artifact families must include at least:
  - file or attachment
  - diff
  - plan or summary
  - command or terminal output excerpt
  - design or generated preview output
- Attachment ingestion must produce stable artifact ids and provenance metadata.
- Artifact visibility must be explicit and must distinguish `local-only` from shared-visible artifacts.
- V1 artifact visibility must remain class-based and policy-based. Participant-specific partial redaction is out of scope for the first implementation.
- Referencing a live workspace file is not sufficient for artifact immutability; the system must capture immutable artifact content or a content-addressed snapshot.
- A shared-visible artifact within the relay size cap must be fetchable by session participants on other nodes **while the publishing node is offline** (eager relay pin at publish — see §Cross-Node Artifact Relay (V1)).
- Relay-held payloads must be ciphertext under a per-artifact content-encryption key (CEK) wrapped once per intended recipient **node** (each participant node holds its own durable artifact-encryption key, so every node unwraps independently); the relay must never hold key material sufficient to decrypt.
- Cross-node payload fetch must be authenticated and bound to the fetching `(participant, node)` pair; capability URLs (secret-in-URL fetch) are prohibited.
- Chunk integrity and whole-payload integrity must be verified against the signed publish-event manifest; any mismatch must fail loudly — never silently-wrong bytes.

## Default Behavior

- Newly uploaded attachments default to local artifact storage with visibility derived from session policy.
- Artifact manifests default to storing producer, session, run, type, created time, and visibility class.
- Shared replication defaults to opt-in or policy-driven behavior rather than automatic blind sharing of all local outputs.
- If an artifact should not be visible to all recipients of a shared-visible class, the default v1 behavior is to keep it `local-only` or publish a separate derived artifact under a different visibility class rather than partially redact the original in place.
- Shared-visible artifacts within `max_artifact_relay_bytes` default to eager relay pin at publish; retention defaults to the `default` tier (7-day TTL) unless the publisher selects another named tier.

## Fallback Behavior

- If shared replication is unavailable, the artifact may remain `local-only` with manifest status `pending_replication` or equivalent.
- If the artifact payload is too large for inline timeline rendering, the timeline must show a manifest row and require explicit fetch for the payload.
- If preview generation fails, the artifact remains valid and retrievable as raw content.
- If current policy does not allow sharing the full payload, the system must retain the original artifact under its current visibility class and may publish a separate redacted or summarized derivative artifact instead of mutating the original.
- If an artifact exceeds `max_artifact_relay_bytes`, or the session/participant relay quota is exhausted, the artifact is not relay-pinned: it stays publisher-local with an explicit degraded manifest status ("unavailable while the publisher is offline") — honest degradation, never silent unavailability.

## Interfaces And Contracts

- `ArtifactPublish` must return artifact id and manifest metadata.
- `ArtifactRead` must return manifest plus retrievable payload handle or inline content where appropriate.
- `ArtifactVisibilityUpdate` must require policy and authorization checks.
- `AttachmentIngest` must normalize names, media type, and size metadata.
- Artifact storage uses an OCI-inspired manifest envelope: `{id: ArtifactId, sessionId, runId, digest: SHA-256, size, artifactType, annotations, subject?, createdAt}`.
- `artifactType` is a discriminator: `"file"`, `"diff"`, `"summary"`, `"log"`, `"design"`, `"workflow_output"` — one value per family enumerated above (`summary` covers the plan/summary family) plus `workflow_output`, the Spec-017 workflow phase-output type (Spec-017:237).
- `subject` field enables artifact linking (e.g., a diff artifact referencing its parent run artifact).
- Cross-node relay methods (additive; see §Cross-Node Artifact Relay (V1)): `ArtifactUploadInit` / `ArtifactUploadChunk` / `ArtifactUploadComplete` (resumable ciphertext-chunk upload to the relay blob store; the received-set is discoverable so an interrupted publisher resumes without re-sending), and `ArtifactFetchAuthorize` (mints a `(participant, node)`-scoped, DPoP-bound, short-lived fetch token — 5–15 min expiry — against session membership) + per-chunk authenticated GETs, then `ArtifactFetchComplete` (the post-verification delivery ack).
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## Cross-Node Artifact Relay (V1)

Shared-visible artifacts are fetchable from any participating node **even while the publishing node is offline**. This is a V1 required property ([ADR-015 amendment 2026-07-08](../decisions/015-v1-feature-scope-definition.md#amendment-2026-07-08-v11-deferred-features-3--2-cross-node-shared-artifacts-pulled-into-v1) — cross-node shared artifacts pulled forward from V1.1). Manifest-first replication is unchanged; the payload leg is an **eagerly pinned relay store-and-forward of chunked, participant-encrypted, digest-addressed ciphertext**. Publisher-online-only fetch is rejected (fails the offline-availability property); lazy cache-on-miss relay population is rejected (a blob no remote peer fetched before the publisher went offline is simply unavailable — the Matrix remote-media-cache gap). The relay is trusted to hold bytes, never to read them: it stores ciphertext and wrapped keys only — the same trust model as the existing E2E-encrypted event relay ([ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)).

### Publish (eager pin)

1. The publishing daemon generates a random per-artifact **content-encryption key (CEK)** and encrypts the payload with XChaCha20-Poly1305 — the existing relay payload cipher. AEAD is normative but **not sufficient**: a non-committing cipher (e.g. AES-CTR) admits multi-plaintext key substitution by a malicious sender (the Matrix "Missing Salamanders" class), and ChaCha20-Poly1305-family AEADs are themselves **not key-committing** — one ciphertext can authenticate under two different keys ([Len et al., partitioning oracles, USENIX Security 2021](https://www.usenix.org/conference/usenixsecurity21/presentation/len); [Albertini et al., USENIX Security 2022](https://www.usenix.org/conference/usenixsecurity22/presentation/albertini)). The publish therefore also derives a **key commitment** — `cekCommitment = SHA-256("ais/artifact-cek-commit/v1" ‖ CEK)` — carried in the signed manifest (step 2); every recipient MUST verify their unwrapped CEK against it **before decrypting** (step 6), so one relay ciphertext commits every recipient to one CEK — and, with the post-decrypt CAS check, to one plaintext.
2. The ciphertext is split into fixed **8 MiB chunks** (`artifact_relay_chunk_bytes`); each chunk is SHA-256-hashed. The daemon builds a **signed chunk manifest** — ordered `{index, ciphertextChunkSha256, size}` rows plus the whole-payload plaintext SHA-256 (the CAS digest already in the artifact manifest), the whole-ciphertext SHA-256, and the `cekCommitment` (step 1) — carried inside the signed, E2E-encrypted `artifact.published` event. Binding the digests to the signed event (blob → event, not merely blob → itself) means a malicious relay cannot substitute a different-but-internally-consistent blob.
3. The CEK is **wrapped once per intended recipient node** — to each attested **durable artifact-encryption X25519 public key**, never to the session-ephemeral X25519 keys (those are zeroed at session end per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md), so a CEK wrapped to them would be orphaned by any recipient restart and the offline-fetch guarantee would fail exactly when it matters). Each participant node generates its artifact-encryption keypair at first need, holds the private half under the [Spec-022](./022-data-retention-and-gdpr.md) daemon master-key custody (the daemon-local `artifact_encryption_keys` store), and announces the public half as an **artifact-key attestation** — signed by the participant's long-term Ed25519 identity key over `session_id ‖ node_id ‖ artifact_public_key` — sent over the established pairwise-encrypted relay channels after the ADR-010 handshake, carried as an **application-level payload inside the existing pairwise ciphertext envelope** ([Spec-008 §Relay Connection Lifecycle](./008-control-plane-relay-and-session-join.md) frame structure — no new frame message type, no `SessionKeyBundle` change; the relay still forwards opaque ciphertext and learns nothing). Publishers cache peers' attested keys for the session lifetime; an unattested or signature-invalid peer key is never wrapped to. The wrapped-key set — one entry per attested `(participant, node)`, each carrying the wrapping key's **thumbprint** so the fetching daemon selects the right private key after restart or rotation — is **uploaded to the relay with the blob**, becoming the `artifact_relay_recipients` rows — the wrapped CEKs' **only** store; each participant's wrapped CEK is returned to them by `ArtifactFetchAuthorize` (step 5). The set deliberately does **not** ride the durable `artifact.published` event — a deliberate divergence from the Signal/WhatsApp/Wire key-in-event precedent: the event log is immutable, replayable session history, so an event-carried key set could never be crypto-shredded, while the relay row is the participant's one erasable key-access record — exactly what makes the CP-014-2 hard-DELETE a true shred. The event carries the signed `cekCommitment`, never the keys. The relay never sees the CEK or plaintext (wrapped keys are opaque to it); one stored blob serves every participant, and each participant's access is independently revocable by crypto-shred (envelope-encryption precedent: AWS KMS data keys; one-ciphertext-plus-per-recipient-key precedent: Wire/Signal attachment fan-out). The **intended-recipient set is the attested `(participant, node)` set at publish time** — membership-epoch-scoped decryptability, the same boundary the pairwise-encrypted event log gives late joiners (they cannot decrypt pre-join events either) and the deliberate posture of group-messaging protocols generally ([MLS RFC 9420](https://www.rfc-editor.org/rfc/rfc9420): new members cannot read pre-join ciphertext). A member or node joining after publish gains access via publisher **re-publish** while online — `ArtifactUploadInit` on an already-pinned digest is an idempotent CAS re-pin that adds recipient rows without re-uploading chunks (step 4) — and until then sees an explicit no-access-key state, never a silent failure. Relay-held wrapped CEKs are deliberately **not** forward-secret against artifact-key compromise (durable availability cannot ride restart-zeroed keys); the exposure is bounded by the TTL ceiling (30 d), refcount GC, and crypto-shred. **Rotation retires, never replaces:** a rotated-out artifact key is retained (keyed by its thumbprint, marked retired, never used for new wraps) until every relay row wrapped to that thumbprint is delivered or TTL-expired, because a within-TTL blob pinned to the retired key must stay fetchable while the publisher is offline. That predicate is deliberately **not** evaluated by asking the relay: the daemon purges a retired key at `retired_at + 30 d` — the `extended`-tier TTL ceiling is a strict upper bound on how long any row wrapped to it can outlive retirement, so a purely local, monotonic clock rule is sound (it over-retains at worst, and never strands a live blob). Erasure still destroys the participant's active and retired keys together (Spec-022 Path 1).
4. The daemon **eagerly uploads** the ciphertext chunks to the relay blob store at publish time (`ArtifactUploadInit` — carrying the **relay-visible lifecycle envelope** as authenticated plaintext: ciphertext digest, size, chunk size/count, `retentionTier`, and the wrapped-CEK recipient entries, because the relay cannot enforce quotas, chunk accounting, or tier TTLs blind — then chunk PUTs → `ArtifactUploadComplete`; resumable via received-set discovery; on an already-pinned digest, upload-init is an idempotent re-pin that may add recipient rows — the re-publish path). Eager pin at publish is what converts offline availability from best-effort to a guarantee.

### Fetch (authenticated; relay-served in V1)

5. A participant fetches via `ArtifactFetchAuthorize` — an **authenticated, `(participant, node)`-scoped, DPoP-bound ([RFC 9449](https://datatracker.ietf.org/doc/html/rfc9449)), short-lived (5–15 min) fetch token** minted against session membership. The **node half of the scope is not a client-supplied body field** but the token's own confirmation claim: DPoP binds the token to the calling node's proof-of-possession public key (RFC 9449 `cnf` / JWK-thumbprint binding), and the daemon's DPoP key is per-node, so the relay derives `(participant, node)` from the presented token and proof alone. Node-scoping is load-bearing rather than cosmetic: recipient rows are keyed `(digest, participant, node)`, so a merely participant-scoped token could neither select the right wrapped CEK for a participant running several nodes nor attribute a delivery ack to the node that actually fetched — one node's ack would clear a sibling node's row and defeat the per-node refcount (I-014-7). The authorize response returns **the calling node's wrapped CEK**, selected by the key thumbprint recorded on that node's row (whose only store is the relay, step 3) — followed by per-chunk authenticated GETs, resumable. Capability URLs are prohibited: they leak via logs/referrers/history, offer no per-participant revocation, and are the abuse surface that shut down Firefox Send; Matrix retrofitted authenticated media (MSC3916) for the same reasons. Authenticated fetch additionally provides per-participant quota attribution and a GDPR access-audit trail.
6. Each chunk is verified against the signed manifest **on arrival** (a bad chunk is rejected and re-requested without discarding verified chunks); the unwrapped CEK is verified against the signed `cekCommitment` **before decrypt**; after reassembly and decrypt, the whole-payload CAS digest is verified end-to-end. The relay polices ciphertext-chunk integrity without keys; the recipient verifies key commitment before decrypt and plaintext integrity after. Only then does the fetching node send an **authenticated `ArtifactFetchComplete` acknowledgement** — the relay MUST NOT infer delivery from the last chunk GET, because verification, decrypt, and the CAS check all happen client-side afterwards: a GET-inferred `delivered_at` could delete the last relay copy before the recipient detects a bad CEK, a digest mismatch, or crashes mid-verify. The ack is the sole writer of `delivered_at` (it also releases the grace lease); an un-acked fetch leaves the row undelivered and the blob lives to its TTL — the deliberate trade (a leaked blob until TTL is recoverable; a prematurely GC'd one is not). The ack **names no row**: the relay resolves the target `(ciphertext_digest, participant_id, node_id)` from the digest under fetch plus the token's own `(participant, node)` claims (step 5), never from a caller-supplied node identifier — otherwise a single compromised or buggy node could mark its siblings delivered and drive the blob to refcount-zero GC while they still need it. The ack is **idempotent**: re-acking an already-delivered row sets nothing and returns success, so a recipient whose ack response was lost in transit safely retries.
7. **Direct-first fetch** (device-to-device when the publisher is reachable, relay as fallback) is criterion-gated to V1.x as [ADR-015 C4](../decisions/015-v1-feature-scope-definition.md#v11-criterion-gated-commitments): it requires a direct daemon-to-daemon transport V1 does not ship (cross-node traffic is relay-mediated per [Spec-024](./024-cross-node-dispatch-and-approval.md)). The wire format below already carries both paths (`replicationStatus` pin states, digest addressing), so the direct leg lands additively.

### Delete (refcount + TTL + crypto-shred)

8. The relay tracks per-recipient delivery at **`(participant, node)` granularity** — each attested node of a participant counts separately, so a participant's second device that has not yet fetched keeps the blob alive (delivery is never truncated by the same participant's first device fetching). A row becomes delivered only on that node's authenticated `ArtifactFetchComplete` ack (step 6), never on a chunk GET. The blob and its wrapped CEKs are GC'd at **refcount → 0 (every `(participant, node)` recipient row acked) or TTL expiry, whichever comes first**, with a **grace lease**: GC must not evict a blob while a known intended recipient has an in-flight resumable fetch. GC is asynchronous — hourly TTL sweep, immediate refcount-zero delete, and eviction at 90% of `node_relay_storage_max` (already-delivered / nearest-TTL blobs first) — never synchronous on the write path.
9. Participant erasure (the [Spec-022](./022-data-retention-and-gdpr.md) surface): crypto-shred the participant's key material — their daemon-local `artifact_encryption_keys` row on every node they run (Spec-022 Path 1, the durable artifact key's only copy) — and hard-DELETE their wrapped-CEK rows across **all their nodes** (Spec-022 Path 2); the relay rows are the wrapped CEKs' only copies, never the event (they can no longer derive the CEK), delete the shared blob at refcount-zero or TTL, emit an audit event, and fan out to every relay node holding the blob. The relay copy is a TTL-bounded transient buffer of ciphertext, not a system of record — the publisher's CAS is. The erasure posture combines NIST SP 800-88 Cryptographic Erase, GDPR Art 5(1)(e) storage limitation, and the CJEU _EDPS v SRB_ recipient-relative reading; stated honestly it is **defensible under the conditions in §State And Data Implications, not a settled EDPB position** — the spec claims "minimal-risk pseudonymised data plus a genuine crypto-shred + TTL erasure mechanism," never "the relay stores no personal data."

### Size, quota, retention (normative defaults; operator-tunable)

| Parameter | Default | Range | Precedent |
| --- | --- | --- | --- |
| `artifact_relay_chunk_bytes` | 8 MiB (fixed; content-defined chunking is pointless on ciphertext) | 5 MiB floor (S3 part minimum) | AWS CLI `multipart_chunksize` |
| `max_artifact_relay_bytes` | 100 MB | 50 MB – 1 GB | Synapse `max_upload_size` 50 MB; Bitwarden Send 500 MB |
| `per_session_relay_bytes` | 1 GB | operator-set | WeTransfer free tier; IPFS `StorageMax` |
| `per_participant_relay_bytes` | 250 MB | operator-set | WeTransfer per-user norms |
| `node_relay_storage_max` | 10 GB | operator-set | IPFS `StorageMax` default |
| `artifact_relay_ttl` (`default` tier) | 7 days | 24 h – 30 d (named tiers: `volatile` 24 h / `default` 7 d / `extended` 30 d) | Bitwarden Send 7 d default, 30 d max; WhatsApp 30 d undelivered; Signal ~45 d transit |
| `incomplete_upload_ttl` | 48 h | 24–72 h | tus `Upload-Expires`; S3 `AbortIncompleteMultipartUpload` |

Retention is a small named tier set, not a free-form TTL, so relays reason about lifecycle uniformly. Over-quota or over-rate upload receives `429 Too Many Requests` + `Retry-After` per [Spec-021](./021-rate-limiting-policy.md), whose registry carries the five relay request-rate rows (`artifact.upload.init`, `artifact.upload.chunk`, `artifact.fetch.authorize`, `artifact.fetch.chunk`, `artifact.fetch.complete`); the byte/storage quotas above are enforced at the relay blob store and are Spec-014-owned. Self-host operators tune down (shorter TTL, smaller quotas) — steady-state footprint is "in-flight undelivered artifacts," not "all artifacts ever" (the Signal/WhatsApp store-until-delivered economics). The blob store's backing engine stays an implementation detail per §Non-Goals; the 8 MiB chunk maps 1:1 onto an S3 multipart part, so S3-compatible object stores are a natural fit without being mandated.

### Failure modes (normative responses)

| Failure | Required response |
| --- | --- |
| Publisher offline at fetch time | The relay serves the eagerly pinned copy — availability is independent of publisher reachability (the core case). |
| Over-cap artifact | Not relay-pinned; publisher-local with explicit degraded manifest status ("unavailable while the publisher is offline"). Never silent. |
| Relay full / quota exceeded | Upload backpressure `429` + `Retry-After`; watermark eviction (90% of `node_relay_storage_max`, delivered/nearest-TTL first); publish degrades to publisher-local with the explicit degraded status. |
| Digest mismatch on fetch | Reject the chunk on arrival and re-request it; verify the whole payload post-decrypt; persistent mismatch surfaces a loud integrity error — never silently-wrong bytes. |
| Recipient crashes after the last chunk GET, before verifying | No `ArtifactFetchComplete` ack is sent, so the row stays undelivered and the blob survives to TTL; the recipient re-fetches and re-verifies. Delivery is never inferred from transport. |
| Recipient rotates its artifact key with a pinned blob still live | The retired key is retained (thumbprint-selected) until every relay row wrapped to it is delivered or TTL-expired, so the offline-fetch guarantee survives rotation; new wraps use the active key. |
| TTL expiry / eviction mid-fetch | Resume returns an explicit expired/unavailable error; the participant re-requests via re-publish (or the C4 direct leg once shipped). The grace lease prevents eviction during a known in-flight fetch. |
| Publisher dies mid-upload | Chunks are independent; the publisher resumes via received-set discovery on reconnect. Orphaned incomplete uploads are reaped at `incomplete_upload_ttl`. |
| Participant erased mid-life | Immediate crypto-shred + wrapped-CEK drop for that participant; blob GC at refcount-zero/TTL; audit event; fan-out to all relay nodes. |
| Malicious or curious relay operator | Sees ciphertext, wrapped keys, and metadata (sizes, timing, participant identities, retention tier) — never plaintext or the CEK. Same trust model as the untrusted relays of magic-wormhole / croc / Syncthing. |
| Abuse (malware/phishing distribution) | No public URL surface — fetch is authenticated-participant-only (closing Firefox Send's fatal gap); revocation rides session membership; denial-of-storage is bounded by the quota envelope. |

### Wire-format additivity

The `artifact.published` event gains additive, schema-versioned fields (old clients ignore unknown fields): `ciphertextDigest`, `chunkSize`, `chunkCount`, `chunkManifest` (or `manifestDigest` when the manifest is fetched out-of-band), `cekCommitment` (the signed key-commitment binding — wrapped CEKs are relay-held per-recipient state returned by `ArtifactFetchAuthorize`, never event-carried), and `retentionTier`. The pin state rides the **existing** `ArtifactManifest.replicationStatus?` field, whose value set is refined to `pending_replication | pinned | over_cap | quota_exceeded | expired` — this is the "deferred owner refinement" the Tier-7 audit's A-014-3 anticipated for that column (the values are now spec-named, so the schema CHECK lands with them). The content-integrity fields ride inside the existing signed, E2E-encrypted payload — the relay never parses them; the **lifecycle envelope** (`retentionTier` plus size/chunk accounting) is deliberately relay-visible at `ArtifactUploadInit` (step 4 — the relay cannot enforce TTLs and quotas blind) and is mirrored inside the signed payload, so a relay that tampers with the tier is evident to every recipient (declared tier vs relay-reported expiry). Digests are multihash-prefixed (`sha256:…`) so a future hash migration is additive. Event lifecycle and blob lifecycle are independent: the `artifact.published` event may outlive the relay blob; the event carries the digest, so a re-publish re-pins and re-associates.

## State And Data Implications

- Artifact manifests are durable records and part of replayable session history.
- Payload storage may differ from manifest storage, but provenance must stay intact across both.
- Artifact visibility changes must be auditable.
- Plan-014 owns the `artifact_manifests` table. Plan-011's `diff_artifacts` references manifests via foreign key.
- Any redacted or summarized shareable derivative must be a separate artifact with its own manifest and provenance rather than an in-place mutation of the original artifact.
- The relay blob store adds control-plane state (Plan-014 CREATEs; see the [ownership map](../architecture/cross-plan-dependencies.md)): blob metadata (ciphertext digest, size, chunk set, TTL/retention tier, pin state), the per-`(participant, node)` wrapped-CEK set (wrapped to durable artifact-encryption keys; the private halves live daemon-local in `artifact_encryption_keys` under Spec-022 master-key custody), per-recipient delivery refcounts with grace leases, and per-session/per-participant quota accounting. The wrapped-CEK rows reference participants, which adds a row to the [Spec-022](./022-data-retention-and-gdpr.md) CP-022-6 erasure fan-out closure — Plan-014 owes the Path-2 reciprocal.
- GDPR conditions that must hold for the crypto-shred posture (each an engineering requirement, not advice): encryption is applied before bytes reach the relay; key isolation is per-participant; key destruction is complete and irreversible **including backups** — and because Postgres PITR/WAL archiving is database-wide, "excluding rows from backup" is not a real mechanism: either the control-plane backup/PITR retention window is bounded at or below the erasure SLA (≤ the 30 d relay-TTL ceiling), or the wrapped-CEK envelopes are stored under a separately-destroyable KEK so a restored backup yields unusable ciphertext (the [Spec-022 §Daemon Master Key](./022-data-retention-and-gdpr.md#daemon-master-key) custody precedent; the daemon-local artifact-key store inherits that backup-exclusion posture wholesale) — the known failure class remains deleting client keys while server ciphertext outlives an unwired delete path; TTL is bounded; shred and deletion are audited without logging plaintext or keys; a hosted relay operates under an Art 28 processor DPA; erasure fans out to every relay node.

## Example Flows

- `Example: A participant uploads a design reference image, which becomes an immutable attachment artifact visible to the session.`
- `Example: A run publishes a diff artifact and a terminal-output artifact. The timeline shows both manifests, but the large terminal payload requires explicit expansion.`
- `Example: A local-only artifact contains sensitive machine-specific data. The participant keeps the original artifact local and publishes a separate summarized artifact for shared discussion instead of partially redacting the original artifact in place.`
- `Example: A participant on node A publishes a 40 MB design bundle as shared-visible and closes the laptop. The relay already holds the encrypted chunks (eager pin at publish); a participant on node B fetches, verifies each chunk against the signed manifest, unwraps their CEK, decrypts, and verifies the CAS digest — with node A offline throughout. After the last intended recipient fetches, the relay copy is GC'd.`
- `Example: A participant publishes a 2 GB dataset. It exceeds the relay cap, so it is not pinned; the manifest replicates with replicationStatus "over_cap" and remote participants see an explicit "unavailable while the publisher is offline" status instead of a silent failure.`

## Implementation Notes

- Artifact immutability matters more than original path convenience.
- Content-addressable storage (CAS) is keyed by SHA-256 for automatic deduplication.
- Attachment manifests should stay small enough for routine timeline and replay use.

## Pitfalls To Avoid

- Treating a live filesystem path as an immutable artifact
- Auto-sharing local artifacts with no visibility classification
- Requiring inline rendering for every artifact regardless of size
- Capability URLs for payload fetch (secret-in-URL: leaks via logs/referrers/history, no per-participant revocation — the Firefox Send failure; fetch is authenticated-participant-only)
- A non-committing encryption posture for relay payloads — a non-AEAD cipher (AES-CTR-class) admits multi-plaintext key substitution ("Missing Salamanders"), and an AEAD alone is still not key-committing (the partitioning-oracle class); the design requires AEAD **plus** the signed `cekCommitment`
- Lazy cache-on-miss relay population presented as offline availability (it is best-effort, not a guarantee — the pin must be eager at publish)
- Synchronous GC on the upload/fetch path (GC is background: TTL sweep + refcount-zero delete + watermark eviction)

## Acceptance Criteria

- [ ] Attachment ingestion produces stable artifact ids and manifests.
- [ ] Artifacts remain readable and attributable after the producing run ends.
- [ ] Large artifacts can be represented in the timeline without forcing full inline payload rendering.
- [ ] A shared-visible artifact within the relay cap published on node A is fetchable on node B while node A is offline.
- [ ] The relay stores only ciphertext and per-`(participant, node)` wrapped CEKs; no relay-side material suffices to decrypt.
- [ ] Payload fetch requires an authenticated, `(participant, node)`-scoped, DPoP-bound authorization; non-member and unauthenticated fetches are refused.
- [ ] A corrupted chunk is rejected on arrival and re-requested; the whole-payload digest is verified post-decrypt; persistent mismatch surfaces a loud integrity error.
- [ ] Over-cap and over-quota artifacts surface the explicit degraded status (`replicationStatus`) rather than failing silently.
- [ ] Participant erasure crypto-shreds that participant's wrapped-CEK rows across all their nodes, the blob is GC'd at refcount-zero or TTL, and an audit event is emitted.
- [ ] A recipient daemon restarted (or its session ended) between publish and fetch still unwraps its relay-held CEK — CEKs are wrapped to durable artifact-encryption keys, never to session-ephemeral X25519 keys.
- [ ] A participant or node joining the session after publish sees an explicit no-access-key state (never a silent failure) and gains access when the online publisher re-publishes (idempotent re-pin adding recipient rows).
- [ ] `delivered_at` advances only on an authenticated `ArtifactFetchComplete` ack sent after chunk, commitment, and CAS verification succeed; a recipient that crashes after its last chunk GET leaves the blob intact until TTL.
- [ ] The relay resolves the acked recipient row from the fetch token's own `(participant, node)` claims, never from a caller-supplied node identifier: one node of a participant cannot mark a sibling node delivered, and a replayed ack is an idempotent no-op.
- [ ] A node that rotated its artifact-encryption key still fetches and unwraps a blob pinned to the retired key while the publisher is offline, until that blob is delivered or TTL-expired.

## ADR Triggers

- If the system changes the local-vs-shared artifact boundary materially, create or update `../decisions/004-sqlite-local-state-and-postgres-control-plane.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: shared artifact replication is manifest-first with deferred payload transfer. Small-payload synchronous optimization does not change the external contract in v1. (Clarified 2026-07-08: "deferred payload transfer" means the payload is decoupled from event delivery and fetched explicitly — it does NOT mean cross-node payload availability is V1.1-deferred. The payload leg is the §Cross-Node Artifact Relay (V1) eager pin + authenticated fetch.)
- V1 decision (2026-07-08 scope pull-forward, [ADR-015 amendment](../decisions/015-v1-feature-scope-definition.md#amendment-2026-07-08-v11-deferred-features-3--2-cross-node-shared-artifacts-pulled-into-v1)): cross-node payload availability while the publisher is offline is a V1 guarantee, delivered by eager relay pin at publish. Direct-first fetch is criterion-gated (ADR-015 C4) on a shipped direct daemon transport; the V1 wire format already carries both paths.
- V1 decision (2026-07-08): retention is a named tier set (`volatile` 24 h / `default` 7 d / `extended` 30 d), not free-form TTLs; relay deletion triggers are refcount-zero and TTL, whichever comes first, with a grace lease for in-flight fetches.
- V1 decision: participant-specific fine-grained artifact redaction is out of scope for v1. Visibility remains class-based, and any redacted shareable form must be published as a separate derivative artifact.
- V1 decision (2026-07-09, Codex round-2): artifact CEKs wrap to **durable per-`(participant, node)` artifact-encryption X25519 keys** (daemon-generated; private halves under Spec-022 master-key custody in the daemon-local `artifact_encryption_keys` table; public halves distributed as Ed25519-identity-signed attestations over the established pairwise relay channels). Wrapping to the ADR-010 session-ephemeral X25519 keys is prohibited — they are zeroed at session end, which would orphan every relay-held CEK on restart and silently void the offline-fetch guarantee. The recipient set is the attested `(participant, node)` set at publish time; late join heals via publisher-online re-publish; post-quantum hybrid wrapping (PQXDH-class) is a named non-goal for V1 — the MLS (RFC 9420) V1.1 upgrade path is where the key-agreement layer evolves.
- V1 decision (2026-07-09, Codex round-4): artifact-key rotation **retires rather than replaces** — the daemon-local store keeps retired keys by thumbprint until every relay row wrapped to them is delivered or TTL-expired (30 d ceiling), so rotation never strands a within-TTL pinned blob behind an offline publisher. Erasure destroys active and retired keys together. The retention predicate is evaluated locally as `retired_at + 30 d` (the tier ceiling bounds it), never by querying the relay.
- V1 decision (2026-07-09, Codex round-5): the relay fetch token is **`(participant, node)`-scoped**, with the node half carried as the DPoP confirmation claim over the per-node proof-of-possession key rather than as a request field. Participant-only scoping was insufficient once recipient rows became per-node: the relay could neither select the correct wrapped CEK for a multi-node participant nor safely attribute an `ArtifactFetchComplete` ack, and a caller-supplied node id would let one compromised node mark its siblings delivered. The ack is idempotent, so a lost ack response is retry-safe.
- V1 decision (2026-07-09, Codex round-4): delivery is **acknowledgement-driven**, not transport-inferred — an authenticated `ArtifactFetchComplete` (a fifth Spec-021 relay registry row) sent after chunk + `cekCommitment` + CAS verification is the sole writer of `delivered_at`, so refcount GC can never delete the last relay copy before the recipient has verifiably decrypted it. An un-acked fetch leaves the blob to its TTL (a recoverable leak) rather than risking an unrecoverable premature delete.
- V1 decision (2026-07-09, Codex round-2): the crypto-shred backup posture names its two real mechanisms — a control-plane backup/PITR retention window bounded ≤ the erasure SLA (30 d relay-TTL ceiling), or wrapped-CEK envelopes under a separately-destroyable KEK (Spec-022 §Daemon Master Key precedent) — because Postgres PITR/WAL archiving is database-wide and cannot exclude rows.
- V1 decision (2026-07-09, Codex round-2): `retentionTier` and size/chunk accounting form the **relay-visible lifecycle envelope**, carried as authenticated plaintext on `ArtifactUploadInit` and mirrored inside the signed E2EE payload (tier tampering is recipient-evident); only the content-integrity fields are relay-opaque.
- V1 decision (Tier-7 NS-19 audit): the `artifactType` discriminator is closed to six values — the five families above plus `workflow_output` (Spec-017:237). The Required-Behavior families list admits "at least" the five, so `workflow_output` is an additive sixth discriminator value, not a families-list rewrite; the closed typed union is the contract in [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md). Content-only amendment — Spec-014 stays `approved`.

## References

- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)
- [Data Architecture](../architecture/data-architecture.md)

### Primary sources — cross-node artifact relay design (accessed 2026-07-08)

Store-and-forward + key-in-event precedent:

- [Wire Security Whitepaper](https://wire-docs.wire.com/download/Wire+Security+Whitepaper.pdf) — one ciphertext upload per asset; per-recipient encrypted key+hash fan-out
- [Signal community — undelivered-message retention](https://community.signalusers.org/t/how-long-does-the-signal-service-hold-undelivered-messages-before-deleting-them/3890/7) and [Signal message delivery notes](https://signal.miraheze.org/wiki/Message_delivery) — store-until-delivered economics, bounded transit retention
- [whatsapp-media-decrypt](https://github.com/ddz/whatsapp-media-decrypt/blob/master/main.go) — WhatsApp media key + `fileEncSha256` digest-in-message model
- [Matrix encrypted attachments (`EncryptedFile`)](https://matrix-org.github.io/matrix-js-sdk/interfaces/types.EncryptedFile.html) and [Client-Server API — sending encrypted attachments](https://spec.matrix.org/latest/client-server-api/#sending-encrypted-attachments) — encrypted-blob upload + key-in-event
- [Matrix MSC3916 — authentication for media](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/3916-authentication-for-media.md) — the retrofit from know-the-URL access to authenticated media
- [Synapse media repository](https://matrix-org.github.io/synapse/latest/media_repository.html) + [configuration](https://matrix-org.github.io/synapse/latest/usage/configuration/config_documentation.html) — `max_upload_size`, remote-media cache (the lazy cache-on-miss gap), `rc_message` rate shape
- ["Missing Salamanders" write-up](https://lotte.chir.rs/2024/08/17/Missing-Salamanders-Matrix-Media-can-be-decrypted-to-multiple-valid-plaintexts-using-different-keys/) — key non-commitment attack class in Matrix media (the non-AEAD variant)
- [Albertini et al. — "How to Abuse and Fix Authenticated Encryption Without Key Commitment" (USENIX Security 2022)](https://www.usenix.org/conference/usenixsecurity22/presentation/albertini) — GCM/ChaCha-Poly1305-class AEADs are not key-committing; the generic publish-and-verify key-commitment fix the `cekCommitment` adopts
- [Len, Grubbs, Ristenpart — "Partitioning Oracle Attacks" (USENIX Security 2021)](https://www.usenix.org/conference/usenixsecurity21/presentation/len) — practical multi-key ciphertext construction against non-committing AEADs
- [MLS — RFC 9420](https://www.rfc-editor.org/rfc/rfc9420) — membership-epoch-scoped decryptability (new members cannot read pre-join ciphertext by design); the precedent for scoping artifact access to the publish-time attested recipient set, and the V1.1 upgrade path where the key-agreement layer evolves
- [Signal PQXDH specification](https://signal.org/docs/specifications/pqxdh/) — the post-quantum hybrid key-agreement upgrade pattern; cited as the shape of the deliberately-deferred PQ non-goal for V1 artifact-key wrapping

Untrusted-relay trust model (pipe tools — prove ciphertext-relay safety, and that pipes cannot serve absent peers):

- [magic-wormhole transit relay](https://github.com/magic-wormhole/magic-wormhole-transit-relay) and [mailbox server](https://github.com/magic-wormhole/magic-wormhole-mailbox-server)
- [Syncthing relay protocol](https://docs.syncthing.net/specs/relay-v1.html) + [relaying docs](https://docs.syncthing.net/users/relaying.html)

Resumable upload + integrity:

- [tus resumable-upload protocol 1.0](https://tus.io/protocols/resumable-upload/1-0-x) — offset discovery, `Upload-Checksum`, `Upload-Expires`
- [S3 multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html), [object-integrity checksums](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html), [abort-incomplete lifecycle](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html), [AWS CLI `multipart_chunksize`/`multipart_threshold` 8 MB defaults](https://docs.aws.amazon.com/cli/latest/topic/s3-config.html)

Retention / quota / GC / abuse envelope:

- [Bitwarden Send lifespan](https://bitwarden.com/help/send-lifespan/) — 7-day default / 30-day max deletion window
- [IPFS garbage collection](https://blog.logrocket.com/guide-ipfs-garbage-collection/) — `StorageMax` 10 GB, hourly `GCPeriod`, 90% `StorageGCWatermark`, pin/refcount semantics
- [Firefox Send](https://en.wikipedia.org/wiki/Firefox_Send) — anonymous capability-URL file relay shut down over abuse; the cautionary case for unauthenticated fetch
- [Synapse per-user quota gap (issue #3339)](https://github.com/matrix-org/synapse/issues/3339) — per-user media quotas are not stock; quota accounting must be built

Authorization + integrity addressing:

- [W3C TAG — Capability URLs finding](https://www.w3.org/2001/tag/doc/capability-urls/) — prefer account-based mechanisms; capability-URL leakage classes
- [RFC 9449 — OAuth 2.0 Demonstrating Proof of Possession (DPoP)](https://datatracker.ietf.org/doc/html/rfc9449) — sender-constrained short-lived fetch tokens
- [AWS KMS data keys (envelope encryption)](https://docs.aws.amazon.com/kms/latest/developerguide/data-keys.html) — encrypt-once, wrap-key-per-recipient pattern
- [multihash](https://multiformats.io/multihash/) — self-describing digest prefixes for additive hash migration

GDPR posture (relay-held ciphertext, crypto-shred, TTL):

- [NIST SP 800-88 Rev. 2](https://csrc.nist.gov/pubs/sp/800/88/r2/final) — Cryptographic Erase as sanitization
- [GDPR Art 5](https://gdpr-info.eu/art-5-gdpr/) (storage limitation), [Art 17](https://gdpr-info.eu/art-17-gdpr/) (erasure), [Art 28](https://gdpr-info.eu/art-28-gdpr/) (processor DPA), [Art 32](https://gdpr-info.eu/art-32-gdpr/) (security of processing), [Recital 26](https://gdpr-info.eu/recitals/no-26/) (identifiability)
- [CJEU _EDPS v SRB_ press release (4 Sept 2025)](https://curia.europa.eu/site/upload/docs/application/pdf/2025-09/cp250107en.pdf) — recipient-relative reading of personal data for parties who cannot decrypt
- [IAPP — is encrypted data personal data under the GDPR](https://iapp.org/news/a/is-encrypted-data-personal-data-under-the-gdpr) — the unsettled relative-vs-absolute debate the spec's honest framing reflects
