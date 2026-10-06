# Artifact Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-011 — Artifacts Files And Attachments

```ts
// --- ArtifactManifest: the persisted manifest record — the OCI-inspired envelope (Spec-012
//     §Interfaces And Contracts) plus the daemon-persisted `state`/`metadata` fields (not in the spec envelope).
//     Defined once here (the `ArtifactManifest` shape Plan-011 Task 1 mints in
//     packages/contracts/src/artifacts/); ArtifactPublish returns it (Spec-012 §Interfaces And Contracts),
//     ArtifactRead returns it plus a payload handle/inline (same spec section). 1:1 with the
//     `artifact_manifests` row's wire-shareable fields. An artifact is never changed in place. ---

// artifactType discriminator (Spec-012 §Interfaces And Contracts) — the five Spec-012 §Required Behavior families (file, diff, summary,
// log, design) plus workflow_output, the Spec-015 §Output Mode Specification workflow phase-output type. Spec-012 §Required Behavior
// admits "at least" those families, so workflow_output adds to them (D-011-3).
type ArtifactType = "file" | "diff" | "summary" | "log" | "design" | "workflow_output";

interface ArtifactManifest {
  id: ArtifactId;
  sessionId: SessionId;
  runId?: RunId;
  createdBy?: string; // = SQLite `created_by` — the device the publishing request came from; absent when the daemon itself produced the artifact
  artifactType: ArtifactType; // discriminator — Spec-012 §Interfaces And Contracts (D-011-3: file|diff|summary|log|design|workflow_output)
  digest: string; // OCI `digest` (SHA-256) = SQLite content_hash — required: a content-addressed manifest always has one (I-011-1)
  size: number; // OCI manifest-descriptor `size` (payload byte length) = SQLite size_bytes — server-derived, always present
  state: ArtifactState;
  // daemon-side provenance, the file name and the media type (Spec-012)
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ArtifactPublish — Spec-012 §Interfaces And Contracts: "must return artifact id and manifest metadata."
// Trust-boundary rule (Spec-012 §Ingest Validation And Payload Bounds (V1)): the ingest
// pipeline binds to the TRUST BOUNDARY, not to a method name. A publish arriving from across the local
// client↔daemon boundary runs the same validation pipeline over `payload`, and one declaring
// `artifactType: "file"` is refused outright and directed to AttachmentIngest — the file family reaches
// the manifest space only through the validated ingest path. Daemon- and engine-produced publishes
// (the common case for the other families) originate inside the boundary and are not re-validated.
interface ArtifactPublishRequest {
  sessionId: SessionId;
  runId?: RunId;
  artifactType: ArtifactType; // discriminator — see ArtifactManifest.artifactType (Spec-012 §Interfaces And Contracts; D-011-3)
  payload: string; // the artifact bytes — UTF-8 text verbatim, or base64 (RFC 4648 §4) under payloadEncoding "base64"; never a binary field, because the Spec-006 local wire is JSON-only. The daemon decodes per the discriminator BEFORE hashing: content_hash and size_bytes bind the DECODED bytes, so an encoded and an unencoded publish of identical content share one CAS entry. A boundary-crossing publish is single-call and the 4 MB frame ceiling binds the SERIALIZED frame: base64's fixed 4/3 expansion gives the predictable ≈3 MB raw ceiling, while a utf8 payload's JSON-escaped size is content-dependent (quotes/backslashes/control characters expand 2–6× under JSON.stringify), so near-ceiling callers publish base64; larger file bytes take the AttachmentIngest trio, and daemon-internal publishes never cross the wire (Spec-012 §Ingest Validation And Payload Bounds (V1))
  payloadEncoding?: "utf8" | "base64"; // default "utf8" — the request-side encoding discriminator
  mediaType: string; // MIME type
  // `size`/`digest` are not here: the daemon derives size_bytes + content_hash from `payload`
  // (D-011-2).
  metadata?: Record<string, unknown>;
}
interface ArtifactPublishResponse {
  manifest: ArtifactManifest; // embedded manifest metadata (Spec-012 §Interfaces And Contracts); manifest.id is the artifact id, manifest.digest the content hash — no resolvable-URL indirection (D-011-2)
}

// ArtifactRead — Spec-012 §Interfaces And Contracts: "must return manifest plus retrievable payload handle or inline content."
// A chat's file is versioned: each write to the same path is a new version kept with the time it was
// written, and a read names the version it wants, the newest when `version` is absent. A picture's natural
// size and a PDF's first page and page count are read with the manifest, for the quick look, so a reader
// reserves a picture's place and draws a PDF's first page before any payload arrives.
interface ArtifactReadRequest {
  artifactId: ArtifactId;
  version?: number; // counted from 1, oldest first; absent reads the newest
  includePayload?: boolean; // absent or false returns the handle only
  // A window of the payload's bytes, `length` bytes from `offset` (counted from 0), at most
  // ARTIFACT_CHUNK_MAX_BYTES so its encoded bytes fit one message; a window reaching past the end answers
  // the bytes up to the end. A payload too large for one message is read whole by asking for its windows
  // in turn, so a text body, a picture or a PDF is never cut short. A range on a read that declines the
  // payload (`includePayload: false`) is refused.
  range?: { offset: number; length: number };
}
// Two arms, never three independent optional members, because only these two replies can be acted on:
// a handle to fetch the bytes with, or the bytes with their encoding. A read that did not ask for the
// payload lands on the handle arm, and so does one that asked but whose encoded payload would not fit in
// one message: a served answer, not a refusal.
type ArtifactReadResponse =
  | (ArtifactReadFacts & { payloadHandle: string }) // CAS key or URL for deferred retrieval
  | (ArtifactReadFacts & {
      payloadHandle?: string; // allowed beside the bytes
      payload: string; // the whole payload, or the window `range` asked for: UTF-8 text verbatim or base64 per payloadEncoding
      payloadEncoding: "utf8" | "base64"; // "utf8" only for byte-exact valid UTF-8 (which JSON round-trips losslessly), "base64" otherwise; callers switch on it, never sniff
    });
interface ArtifactReadFacts {
  manifest: ArtifactManifest; // the same envelope ArtifactPublish embeds (Spec-012 §Interfaces And Contracts)
  versionNumber: number; // the version in view, counted from 1 and never above versionCount
  versionCount: number; // how many versions exist, which the file pane's stepper reads
  versionWrittenAt: string; // when the version in view was written
  naturalSize?: { width: number; height: number }; // a picture only, in pixels as measured at ingest
  pdfPreview?: { firstPageArtifactId: ArtifactId; pageCount: number }; // a PDF whose first page could be generated
}

// ArtifactList — the session's artifacts: every plan the agent finished and, on a chat session, every
// file and folder the chat wrote. The inspector's `Artifacts` section and a chat's files-written row both
// read it. A plan's state word is its manifest's `state`.
interface ArtifactListRequest {
  sessionId: SessionId;
}
interface ArtifactListResponse {
  artifacts: Array<{
    manifest: ArtifactManifest;
    title: string; // a plan's first heading; a file's or folder's path
    versionCount: number;
  }>;
}

// AttachmentIngest — the interface family purpose-built for untrusted caller-supplied bytes, and the
// primary surface the Spec-012 §Ingest Validation And Payload Bounds (V1) pipeline binds (the pipeline
// binds to the trust boundary, not to a method name — see the ArtifactPublish note above for the
// boundary-crossing publish arm). The other artifactType families are daemon- or engine-produced
// in the common case and carry no untrusted-upload surface. Ingest is a THREE-CALL STREAM, not a
// single payload-bearing call (Spec-012 §Ingest Validation And Payload Bounds (V1),
// transport binding): the local IPC transport enforces a hard 4 MB per-frame ceiling on the declared
// Content-Length BEFORE buffering the body (MAX_MESSAGE_BYTES, declared in
// packages/contracts/src/jsonrpc/message.ts and enforced by
// packages/runtime-daemon/src/ipc/local-gateway.ts, Spec-006 §Wire Format), so a payload
// larger than one frame cannot cross it and a single-call shape would be
// un-implementable on this wire. Chunks spool to a daemon-held temporary file OUTSIDE the CAS until
// Complete; the byte bound binds three times — the transport frame ceiling, Init's declared total, and
// the spooled running count at every Chunk, whose first breach terminates the stream and deletes the
// spool. An abandoned stream's spool is reaped by a daemon-local mtime-clocked reaper 48 h after
// its last write. The stream is a PROTOCOL, not a loose call
// sequence (Spec-012 stream protocol): Init is refused
// artifact.ingest_capacity_exhausted (429 — transient, retry later, no stream state created) at
// max_active_ingest_streams or when the spool's volume, its free space read at admission, has no room
// for the declaration beside the open streams' reservations; sequencing is retry-idempotent with violations terminal
// (artifact.ingest_stream_invalid, 409 — restart from Init); and a stream's tenure is wall-clock-
// bounded by max_ingest_stream_lifetime from Init, because the mtime reaper cannot see a hostile
// trickle that keeps its spool young. `mediaType` and `declaredSizeBytes` are ADVISORY
// INPUT, never trusted facts: the daemon derives both from the spooled bytes at Complete and
// reconciles — with per-field consequences that are deliberately NOT the same.
// A declared TYPE never refuses anything: the type read from the bytes is recorded and the
// declaration is dropped (Spec-012 pipeline step 1). A smaller actual SIZE resolves to the derived
// value in the response — but the declaration is also the stream's
// spool RESERVATION and per-stream ceiling: the running decoded count exceeding it
// refuses artifact.too_large (413) and deletes the spool, because admission against the disk's room
// counts declared bytes and an unenforced declaration would make it gameable. The derived
// values are what reach the manifest, the CAS key, and every downstream consumer.
// EVERY call of the trio is retry-safe against a lost response, and no member of these shapes carries
// idempotency state: a retried Chunk is acknowledged
// without re-appending, and a retried Complete returns the saved result, its original response
// verbatim, from a completion record the daemon holds on the stream's own registry entry. Calls on one ingestId are
// additionally SINGLE-FLIGHT — sequence validation, spool append, running-count and digest advance,
// and acknowledgment run as one critical section per stream — so an original racing its own retry
// takes the retry path rather than double-appending; concurrent calls on DIFFERENT streams never
// contend. Admission is likewise a serialized reserve-then-install ledger over the open-stream count
// and the reservation total against the disk's free space, so two concurrent Inits cannot both pass
// one remaining slot's bound.
// The trio's request shapes live in `packages/contracts/src/artifacts/`, beside `ArtifactListRequest`
// and `ArtifactReadRequest`. The trio has no abort call: Spec-012 names none, and an abandoned
// stream's spool is reaped as above.
interface AttachmentIngestInitRequest {
  sessionId: SessionId;
  runId?: RunId;
  fileName: string; // caller-supplied; length/character-bounded before it is recorded, and NEVER a storage path component — CAS addressing keys the payload by its SHA-256 (Spec-012 §Implementation Notes)
  mediaType?: string; // ADVISORY and OPTIONAL — absent is a first-class state; the type read from the bytes is what the manifest records, and no declaration refuses anything (Spec-012 pipeline step 1)
  declaredSizeBytes: number; // ADVISORY as metadata, BINDING as a reservation: reserved against the spool volume's free space, read at admission (a declaration the free disk cannot hold even with no other stream open is refused artifact.too_large (413) up front, naming the file and the room the disk has, since waiting can never admit it), and enforced as the stream's per-stream spool ceiling — the running decoded count may not exceed it; a smaller actual size reconciles downward at Complete without refusal
}
interface AttachmentIngestInitResponse {
  ingestId: string; // opaque single-use stream handle, session-bound and wall-clock-bounded by max_ingest_stream_lifetime from Init; scopes every subsequent Chunk/Complete call — each refused artifact.ingest_stream_invalid (409) once the stream is terminated, expired, or unknown, and every Chunk once it is completed. ONE carved exception: a retried Complete on a completed stream whose completion record still lives returns the saved result, the original response verbatim — see AttachmentIngestCompleteRequest
}
interface AttachmentIngestChunkRequest {
  ingestId: string;
  sequenceNumber: number; // 0-based, strictly consecutive. The daemon retains the last acknowledged sequence + the last appended chunk's SHA-256: an exact retry — same sequence, same bytes, the ordinary retry after a lost Chunk response — is acknowledged idempotently WITHOUT re-appending, so client retries are always safe; a same-sequence chunk with different bytes, a gap, or a regression terminates the stream (spool deleted) and refuses artifact.ingest_stream_invalid (409) — restart from Init
  chunk: string; // base64 (RFC 4648 §4) of at most max_attachment_chunk_bytes = 512 KiB raw payload (Spec-012 §Bounds) — the Spec-006 wire is JSON with no binary serialization, so bytes ride encoded, sized so the 4/3 expansion plus envelope fits the frame ceiling by arithmetic; the spool append decodes, and every byte bound counts the DECODED bytes
}
interface AttachmentIngestChunkResponse {
  ingestId: string;
  receivedBytes: number; // spooled running total of DECODED bytes after this chunk — the enforced byte bound; exceeding the Init-declared total refuses with artifact.too_large (413) and deletes the spool
}
interface AttachmentIngestCompleteRequest {
  ingestId: string; // the request's ONLY member — Complete runs the pipeline over the spooled bytes (type detection reads a bounded leading prefix); step 3's admitting CAS rename commits the payload — admission is the pipeline's final successful act (Spec-012 pipeline step 3). IDEMPOTENT within the stream's lifetime: the response is recorded on the stream's registry entry, stamped with the committed digest, so a retry after a lost response returns that saved response VERBATIM — same artifactId, same contentHash — re-running no gate and inserting no second manifest row. Because this request carries no member beyond the ingestId, a "divergent" Complete has no wire form; the digest stamp is a fail-closed defense-in-depth check against a state a daemon-minted single-use handle makes unreachable, not a caller-supplied discriminator. The record shares the entry's in-memory lifetime, so past max_ingest_stream_lifetime the retry receives artifact.ingest_stream_invalid (409) and a re-ingest costs a second manifest row over one deduplicated CAS payload, never duplicated bytes
}
interface AttachmentIngestCompleteResponse {
  artifactId: ArtifactId;
  contentHash: string;
  normalizedName: string;
  derivedMediaType: string; // read from the payload's bytes — this, not Init's `mediaType`, is what the manifest records; returned so a caller that guessed wrong learns the reconciled truth
  derivedSizeBytes: number; // server-derived byte length of the spooled payload — likewise authoritative over Init's declared bound
}

// --- Attachment references on turn-scoped carriers (Spec-012 §Interfaces And Contracts).
//     The element type is ArtifactId — an id into Spec-012's manifest space — carried as an ordered
//     ArtifactId[], never an untyped element and never an inline byte payload: a carrier references
//     artifacts by id only, and caller bytes enter through the boundary-validated ingest paths — the
//     AttachmentIngest trio, or a boundary-crossing ArtifactPublish payload, both of which run the
//     Spec-012 validation pipeline before anything is admitted. Caller-declared order
//     is preserved end to end, and an element the turn cannot resolve or deliver surfaces as an explicit
//     unresolved marker in its declared position naming its cause, `deleted` — silently dropping it
//     is prohibited (Spec-012 §Fallback Behavior). A carrier holds as many attachments as the daemon
//     and the provider accept, with no count of the app's own.
//     The driver-boundary
//     steer and intervention arms were typed `unknown[]` and DELIBERATELY NOT edited from the Plan-011
//     side, because those wire arms belong to the plans that own the driver boundary and retyping them
//     was registered as the Plan-011 cross-plan follow-up obligation CP-011-1 so the change would land
//     under its owners. IT HAS: both arms are `ArtifactId[]`, typed by Plan-003
//     (SteerPayload, provider-driver-payloads.md §Plan-003 — where the carrier contract is stated once) and Plan-002 (the
//     message's `attachments` on QueueItemCreateRequest, `run.queueCreate`, run-control-payloads.md §Plan-002), so every V1 attachment carrier registered
//     here is typed and CP-011-1's prerequisite — no V1 carrier may be wired to deliver an
//     attachment over an untyped arm — holds. ---
```

> **The artifact manifest envelope.** The ArtifactPublish/ArtifactRead pair composes a single named `ArtifactManifest` envelope ([Spec-012 §Interfaces And Contracts](../../specs/012-artifacts-files-and-attachments.md#interfaces-and-contracts)) instead of inlining and duplicating the fields — this is the `ArtifactManifest` shape Plan-011 Task 1 mints. `ArtifactPublishResponse` embeds `manifest: ArtifactManifest` per [Spec-012 §Interfaces And Contracts](../../specs/012-artifacts-files-and-attachments.md#interfaces-and-contracts) ("must return artifact id **and manifest metadata**"): the `ArtifactRead` clause grants handle/inline latitude to the **payload** on _Read_ only, never to the manifest, so both responses return the manifest metadata inline (D-011-2). `ArtifactReadResponse` is `manifest` + `payloadHandle?`/`payload?` ([Spec-012 §Interfaces And Contracts](../../specs/012-artifacts-files-and-attachments.md#interfaces-and-contracts)). The wire envelope mirrors the `artifact_manifests` row in [Local SQLite Schema](../schemas/local-sqlite-schema.md) 1:1: `digest`/`size` are **required** on the wire because a content-addressed manifest always carries both (I-011-1), and the at-rest `content_hash`/`size_bytes` columns are correspondingly **`NOT NULL`** — each producer (AttachmentIngest, ArtifactPublish) computes the SHA-256 + byte length from its own payload and inserts its manifest with both columns set in the same transaction as the payload-ref, and AttachmentIngest and ArtifactPublish are independent producers (the `artifactId` `AttachmentIngestCompleteResponse` returns resolves from the ingest-written manifest, not a later publish), so there is no payload-less manifest to reconcile (D-011-1). Producer inputs are closed too (D-011-2): `size`/`digest` stay server-derived from `payload`, and the file name rides in `metadata`. An artifact is never changed in place.

**Plan artifacts and a chat's files.** Two console surfaces are projections of this manifest space and add no store of their own. **A finished plan** is written by the daemon as an artifact of its session in the existing summary family the moment the plan turn ends, keyed by its own stable id and carrying the plan's text as the agent wrote it; its state moves in place as the plan is answered, so the inspector's artifact list reads the plan's word — waiting, accepted, handed on — and the plan reader renders the STORED text and never the provider's own plan file. The artifact survives a restart and is listed on the person's other devices, which is the whole reason the plan is an artifact rather than a rendering of a held request. **A chat session's files** are artifacts too: every file and folder a chat writes into its managed workspace is one, and each write to the same path is a NEW VERSION of that artifact kept with the time it was written — a later write never replaces an earlier one, which is what lets the file pane step through versions and compare one against the one before it. That comparison is the only diff a chat draws and it is never against a repository, so no branch, commit, base or staging concept reaches it.

The session screen reads this manifest space through these methods on the daemon JSON-RPC transport. `artifact.list` is read again on `artifact.published` rather than on a timer.

| Method          | Procedure type | Request schema        | Response schema        |
| --------------- | -------------- | --------------------- | ---------------------- |
| `artifact.list` | `query`        | `ArtifactListRequest` | `ArtifactListResponse` |
| `artifact.read` | `query`        | `ArtifactReadRequest` | `ArtifactReadResponse` |
