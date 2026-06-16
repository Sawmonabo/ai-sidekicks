# Plan-014: Artifacts Files And Attachments

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `014` |
| **Slug** | `artifacts-files-and-attachments` |
| **Date** | `2026-04-14` (Tier-7 readiness audit 2026-06-15; flipped to `review` then re-promoted to `approved` in the audit swap) |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-014: Artifacts Files And Attachments](../specs/014-artifacts-files-and-attachments.md) |
| **Required ADRs** | [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (artifact_publication event taxonomy + EventLogService.append), [Plan-007-partial](./007-local-ipc-and-daemon-control.md) (artifact.\* IPC namespace registry substrate) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |
| **References** | [Updated Spec-014](../specs/014-artifacts-files-and-attachments.md) (OCI manifest envelope, CAS) |

## Goal

Implement immutable artifact publication, attachment ingestion, and manifest-first visibility handling across local and shared session contexts.

## Scope

This plan covers artifact ids and manifests, attachment ingest, payload storage, visibility classification, and shared-replication state.

## Non-Goals

- Full artifact preview UX
- Notification behavior for artifact publication
- Remote object-store vendor selection

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred
- [x] **Plan-readiness audit complete per [runbook](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier-7 audit (2026-06-15): 10 findings adjudicated via A-014-1..6; D-014-1..4 ratified. The plan was flipped to `review` during the audit (the OCI-envelope columns + CP-014-1 are a NEW contract surface) and **re-promoted to `approved`** in the same swap on ratification of the OCI-envelope/wire bundle (D-014-1 manifest columns, D-014-2 dedicated `annotations` column, D-014-3 embedded-manifest wire) and resolution of the `artifactType` discriminator (D-014-4 — six values). Companion amendments: api-payload-contracts.md (`ArtifactManifest` envelope + `ArtifactType` union), local-sqlite-schema.md (`artifact_manifests` `subject`/`size_bytes`/`annotations`/`replication_status`), spec-014.md (line 73/119 six-value discriminator — content-only, Spec-014 stays `approved`), cross-plan-dependencies.md §3/§4 (Plan-006 + Plan-007-partial edges).

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/artifacts/`
- `packages/runtime-daemon/src/artifacts/artifact-publish-service.ts`
- `packages/runtime-daemon/src/artifacts/attachment-ingest-service.ts`
- `packages/runtime-daemon/src/artifacts/payload-store.ts`
- `packages/control-plane/src/artifacts/artifact-manifest-service.ts`
- `packages/client-sdk/src/artifactClient.ts`
- `apps/desktop/src/renderer/src/artifacts/`

## Data And Storage Changes

- Add durable `artifact_manifests`, `artifact_payload_refs`, and replication-status records with provenance, visibility class, and producer metadata.
- Keep manifest storage separate from large payload storage while preserving content-addressed lookup or equivalent immutable payload identity.
- Treat any redacted or summarized shared form as a separate derivative artifact record rather than as in-place mutation metadata on the original artifact.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## API And Transport Changes

- Add `ArtifactPublish`, `ArtifactRead`, `ArtifactVisibilityUpdate`, and `AttachmentIngest` to shared contracts and the typed client SDK.
- Return manifest metadata first and use explicit payload handles for large or deferred content reads.

## Invariants

- **I-014-1 (Immutability):** A published artifact's payload is content-addressed (SHA-256) and never mutated in place; a live workspace path is never treated as durable payload identity. (Spec-014 line 50; verified by Task 2, Task 3.)
- **I-014-2 (Derivative-not-mutation):** A redacted/summarized shareable form is a separate manifest (own id, `subject` → original); the original manifest is never UPDATEd in place. (Spec-014 line 84; verified by Task 4.)

## Cross-Plan Obligations (provided)

- **CP-014-1 → Plan-011:** Plan-014 ships the OCI manifest envelope (incl. `subject`, `annotations`, `size`, `digest`=content_hash) and the `artifact_manifests`/`artifact_payload_refs` tables that Plan-011's `diff_artifacts.artifact_manifest_id` FK references. Plan-011's DiffArtifact (`artifactType: "diff"`) consumes this envelope (Plan-011 line 62, Spec-011 line 86).

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

#### Tasks

- **Task 1 — Artifact contracts.** In `packages/contracts/src/artifacts/`, define `ArtifactManifest` (full OCI envelope per D-014-1), `PayloadHandle`, `ArtifactVisibility` (`"local-only" | "shared"`), `ArtifactState` (`"pending" | "published" | "superseded"`), and the `AttachmentIngest` request/response. **Assertion:** schemas parse the api-payload-contracts.md ArtifactPublish/Read/VisibilityUpdate/AttachmentIngest shapes round-trip. The `ArtifactType` union covers the closed six-value discriminator (Spec-014 line 73: `file | diff | summary | log | design | workflow_output`) — RESOLVED (D-014-4). **Spec coverage:** Spec-014 line 66-71 (interfaces), line 72-73 (envelope + discriminator). **Consumes:** ArtifactState, ArtifactVisibility, ArtifactId ← api-payload-contracts.md lines 171,172,57 (by SHAPE); ArtifactType ← Spec-014 line 73 reconciled (RESOLVED D-014-4: closed six-value union `file | diff | summary | log | design | workflow_output` in api-payload-contracts.md).

- **Task 2 — Attachment ingest + immutable payload store.** Implement `runtime-daemon/src/artifacts/attachment-ingest-service.ts` and `payload-store.ts`: normalize name/media-type/size, compute SHA-256, write the CAS-keyed payload blob, mint a stable `ArtifactId`. (The `artifact_payload_refs` row is **not** written here — its `manifest_id NOT NULL REFERENCES artifact_manifests(id)` FK ([`artifact_payload_refs`](../architecture/schemas/local-sqlite-schema.md#artifact-tables-plan-014)) requires the manifest to exist first, so the ref is persisted in Task 3 within the manifest transaction.) **Assertion:** ingesting the same bytes twice yields one CAS entry (dedup at the content-hash level — independent of any per-manifest payload-ref); the ingested artifact has a stable id and normalized media_type/size_bytes. **Spec coverage:** Spec-014 line 47 (stable ids + provenance), line 71 (normalize name/media/size), AC line 106. **Verifies invariant:** I-014-1 (immutability — A-014-6).

- **Task 3 — Artifact publication + manifest persistence.** Implement `runtime-daemon/src/artifacts/artifact-publish-service.ts` and `control-plane/src/artifacts/artifact-manifest-service.ts`: persist `artifact_manifests` (incl. `subject`, `size_bytes`, `annotations` per D-014-1 / D-014-2 — `annotations` a dedicated OCI string-map column, not freeform `metadata`) and, **in the same transaction**, the `artifact_payload_refs` row linking the manifest to its Task-2 CAS blob (`manifest_id` → the just-inserted manifest id, `storage_path` → the CAS key) — written here, not at ingest, because the payload-ref FK (`manifest_id NOT NULL REFERENCES artifact_manifests(id)`, [`artifact_payload_refs`](../architecture/schemas/local-sqlite-schema.md#artifact-tables-plan-014)) requires the manifest first; default visibility from session policy, set state. `ArtifactPublish` returns the embedded `ArtifactManifest` envelope (Spec-014 line 68 "must return artifact id **and manifest metadata**"; `manifest.id` is the artifact id) — **not** a `manifestUrl` pointer (D-014-3: the prior pointer was wire drift from that "must" clause — line 69 grants handle/inline latitude to the _payload_ on `ArtifactRead` only, never to the manifest, so publish embeds the metadata; see api-payload-contracts.md `ArtifactManifest`). **Assertion:** published artifact is readable + attributable (producer/session/run) after the producing run ends; the `ArtifactPublish` response embeds the `ArtifactManifest` (`id`, `digest`, `size`, `annotations`, `subject?`, `visibility`, `state`, `replicationStatus?`, `createdAt`); publishing two artifacts ingested from identical bytes yields two distinct manifests, each with its own `artifact_payload_refs` row, both pointing at the one shared CAS blob (dedup is CAS-level, not manifest-level). **Spec coverage:** Spec-014 line 40 (immutable publication + durable manifests), line 68 (ArtifactPublish returns id+manifest metadata), line 72 (OCI envelope shape), AC line 107. **Verifies invariant:** I-014-1.

- **Task 4 — Replication-status + derivative artifacts.** Persist the manifest-first replication-status surface (per A-014-3) and model derivatives as separate manifests with `subject` linkage (per A-014-4). ArtifactVisibilityUpdate enforces policy/auth. **Assertion:** a shared-visible artifact with no payload yet replicated shows the pending-replication status; a derivative is a distinct manifest row (own id) whose `subject` points to the original, and the original row is never UPDATEd in place. **Spec coverage:** Spec-014 line 61 (pending_replication fallback), line 64 + 84 (derivative not in-place mutation), line 70 (visibility-update policy/auth). **Verifies invariant:** I-014-2 (derivative-not-mutation — A-014-6). **Consumes:** `replication_status` column ← Plan-014-owned (RESOLVED A-014-3): authored nullable, spec-named `pending_replication` per Spec-014:61; no multi-state CHECK (terminal/failed values are a deferred owner refinement — anti-fabrication, none invented).

- **Task 5 — Artifact events.** Emit `artifact.published` / `artifact.visibility_updated` / `artifact.superseded` via Plan-006's `EventLogService.append` with the Spec-006 payload shape; register `artifact.*` IPC handlers under Plan-007's registry. (A-014-5.) **Assertion:** publishing an artifact appends an `artifact.published` event to the session timeline with `{sessionId, artifactId, runId?, visibility, state}`; visibility change appends `artifact.visibility_updated`. **Spec coverage:** Spec-014 line 80 (manifests part of replayable session history). **Consumes:** EventLogService.append ← Plan-006; `artifact_publication` taxonomy ← Spec-006 lines 265-275 (by SHAPE); IPC registry ← Plan-007-partial.

- **Task 6 — Desktop artifact surfaces.** In `apps/desktop/src/renderer/src/artifacts/`, render manifest rows, explicit payload-fetch action for large payloads, and visibility state. **Assertion:** a large artifact shows a manifest row + explicit fetch control and does NOT force inline payload render. **Spec coverage:** Spec-014 line 62 (large payload → manifest row + explicit fetch), AC line 108. **Consumes:** artifactClient ← `packages/client-sdk/src/artifactClient.ts` (Task 1 contracts).

## Parallelization Notes

- Manifest-contract work and payload-store implementation can proceed in parallel once visibility classes are fixed.
- Shared-replication work should wait for manifest schema and pending-replication semantics to stabilize.

## Test And Verification Plan

- Attachment-ingest tests covering stable ids, normalized metadata, and immutable payload reads
- Visibility tests covering `local-only`, shared-visible, and pending-replication transitions
- Large-artifact tests proving timeline manifests remain usable without forcing inline payload rendering
- Derivative-artifact tests proving redacted or summarized shared forms preserve separate provenance and do not mutate the original artifact

## Rollout Order

1. Land manifest contracts and local payload storage
2. Enable attachment ingest and artifact publication in local sessions
3. Enable shared-visible replication and visibility-update flows

## Rollback Or Fallback

- Keep artifacts local manifest-first and disable shared replication if replication-state handling regresses.

## Risks And Blockers

- Manifest-first versus synchronous small-payload replication remains unresolved (deferral tracked in parent [Spec-014](../specs/014-artifacts-files-and-attachments.md))
- Artifact immutability will be undermined if live workspace paths are allowed to masquerade as durable payload identity
- Pressure for participant-specific redaction can create accidental in-place mutation semantics unless derivative-artifact handling stays explicit

## Ratified Design Decisions (Tier-7 audit)

- **D-014-1 — The OCI manifest envelope is realized as dedicated `artifact_manifests` columns + a named `ArtifactManifest` wire shape.** Spec-014:72 specifies an OCI-inspired envelope (`subject`, `size`, `annotations`, `digest`=content_hash). The audit authored `artifact_manifests.subject` (self-referential FK), `size_bytes`, and `annotations` columns (local-sqlite-schema.md) and the matching `ArtifactManifest` wire shape (api-payload-contracts.md), plus the CP-014-1 obligation that Plan-011's `diff_artifacts.artifact_manifest_id` FK references. This is a NEW contract surface — it is why Plan-014 was flipped to `review` and re-promoted only on ratification.
- **D-014-2 — `annotations` is a dedicated OCI string→string column, not folded into freeform `metadata`.** The OCI `annotations` map is a first-class manifest property ([OCI image-manifest spec](https://github.com/opencontainers/image-spec/blob/main/manifest.md)); it gets its own `artifact_manifests.annotations` column and a distinct `ArtifactManifest.annotations` wire field so the at-rest shape is 1:1 with the wire, while `metadata` stays purely freeform daemon-side provenance.
- **D-014-3 — `ArtifactPublish`/`ArtifactRead` compose a single named `ArtifactManifest`; publish embeds the manifest metadata (no `manifestUrl` pointer).** Spec-014:68 mandates that publish return "artifact id **and** manifest metadata"; the prior `manifestUrl` pointer was drift from that clause (Spec-014:69 grants handle/inline latitude to the _payload_ on `ArtifactRead` only, never to the manifest). The wire now embeds `manifest: ArtifactManifest` on publish and `manifest` + `payloadHandle?`/`payload?` on read; producer inputs (`subject?`, `annotations?`) are accepted at publish so the `annotations` column and derivative `subject` are not write-dead. Aligns the wire to the spec — not a new owner decision.
- **D-014-4 — The `artifactType` discriminator is a closed six-value union: `file | diff | summary | log | design | workflow_output`.** Spec-014:41 enumerates five families (`summary` covers the plan/summary family); the audit adds `workflow_output` (the Spec-017:237 Tier-8 workflow phase-output type) as an additive sixth value. The Required-Behavior families list admits "at least" the five, so this is an additive discriminator value, not a families-list rewrite. The closed typed union is the contract (api-payload-contracts.md `ArtifactType`); the schema CHECK mirrors it (`CHECK(artifact_type IN ('file','diff','summary','log','design','workflow_output'))`).

## Progress Log

### Shipment Manifest

<!-- Machine-readable. Housekeeper-emitted, orchestrator-written, preflight-read.
     Schema authoritative in:
       .claude/skills/plan-execution/scripts/lib/manifest.mjs -->

```yaml
manifest_schema_version: 1
shipped: []
```

### Notes

<!-- Per-PR human commentary (round-trips, learnings, partial-ship details). Append-only. -->

- 2026-06-15 — Tier-7 plan-readiness audit (NS-19): 10 findings adjudicated via A-014-1..6; D-014-1..4 ratified. The plan was flipped to `review` (the OCI-envelope columns + CP-014-1 are a NEW contract surface) and re-promoted to `approved` in the same swap on ratification of the OCI-envelope/wire bundle (D-014-1/D-014-2/D-014-3) and resolution of the `artifactType` discriminator (D-014-4 — six values `file|diff|summary|log|design|workflow_output`). Adjudications: A-014-1 — CP-014-1 records the envelope/tables Plan-011's DiffArtifact consumes; A-014-2 — the six-Task `#### Tasks` block was authored as audit backfill; A-014-3 — the `replication_status` column realizes the Spec-014:61 manifest-first surface (nullable, spec-named `pending_replication`, no multi-state CHECK — terminal values are a deferred owner refinement, anti-fabrication); A-014-4 — derivatives are separate manifests via the `subject` self-FK (I-014-2), never in-place mutation; A-014-5 — Dependencies row + dep-map §3/§4 Plan-006 (`EventLogService.append` / `artifact_publication` taxonomy) + Plan-007-partial (`artifact.*` IPC registry) edges; A-014-6 — §Invariants I-014-1 (immutability) / I-014-2 (derivative-not-mutation). Companion amendments: api-payload-contracts.md, local-sqlite-schema.md, spec-014.md (content-only, stays `approved`), cross-plan-dependencies.md §3/§4. No upstream-tier or sealed-plan amendments.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
