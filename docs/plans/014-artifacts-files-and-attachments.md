# Plan-014: Artifacts Files And Attachments

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `014` |
| **Slug** | `artifacts-files-and-attachments` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-014: Artifacts Files And Attachments](../specs/014-artifacts-files-and-attachments.md) |
| **Required ADRs** | [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | None |
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

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define artifact manifest, payload-handle, visibility, and attachment-ingest contracts in shared packages.
2. Implement daemon-side attachment ingestion, immutable payload storage, and artifact publication flows.
3. Implement manifest persistence plus replication-status handling for shared-visible artifacts and derivative shareable artifacts.
4. Add desktop artifact surfaces for manifest rows, payload fetch, and explicit visibility state.

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

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
