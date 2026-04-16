# Spec-014: Artifacts Files And Attachments

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `014` |
| **Slug** | `artifacts-files-and-attachments` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md), [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md), [Data Architecture](../architecture/data-architecture.md) |
| **Implementation Plan** | [Plan-014: Artifacts Files And Attachments](../plans/014-artifacts-files-and-attachments.md) |

## Purpose

Define the canonical handling of artifacts, file attachments, and immutable output payloads.

## Scope

This spec covers artifact types, attachment ingestion, storage expectations, manifests, and visibility.

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

## Default Behavior

- Newly uploaded attachments default to local artifact storage with visibility derived from session policy.
- Artifact manifests default to storing producer, session, run, type, created time, and visibility class.
- Shared replication defaults to opt-in or policy-driven behavior rather than automatic blind sharing of all local outputs.
- If an artifact should not be visible to all recipients of a shared-visible class, the default v1 behavior is to keep it `local-only` or publish a separate derived artifact under a different visibility class rather than partially redact the original in place.

## Fallback Behavior

- If shared replication is unavailable, the artifact may remain `local-only` with manifest status `pending_replication` or equivalent.
- If the artifact payload is too large for inline timeline rendering, the timeline must show a manifest row and require explicit fetch for the payload.
- If preview generation fails, the artifact remains valid and retrievable as raw content.
- If current policy does not allow sharing the full payload, the system must retain the original artifact under its current visibility class and may publish a separate redacted or summarized derivative artifact instead of mutating the original.

## Interfaces And Contracts

- `ArtifactPublish` must return artifact id and manifest metadata.
- `ArtifactRead` must return manifest plus retrievable payload handle or inline content where appropriate.
- `ArtifactVisibilityUpdate` must require policy and authorization checks.
- `AttachmentIngest` must normalize names, media type, and size metadata.
- Artifact storage uses an OCI-inspired manifest envelope: `{id: ArtifactId, sessionId, runId, digest: SHA-256, size, artifactType, annotations, subject?, createdAt}`.
- `artifactType` is a discriminator: `"diff"`, `"design"`, `"file"`, `"log"`.
- `subject` field enables artifact linking (e.g., a diff artifact referencing its parent run artifact).
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.

## State And Data Implications

- Artifact manifests are durable records and part of replayable session history.
- Payload storage may differ from manifest storage, but provenance must stay intact across both.
- Artifact visibility changes must be auditable.
- Plan-014 owns the `artifact_manifests` table. Plan-011's `diff_artifacts` references manifests via foreign key.
- Any redacted or summarized shareable derivative must be a separate artifact with its own manifest and provenance rather than an in-place mutation of the original artifact.

## Example Flows

- `Example: A participant uploads a design reference image, which becomes an immutable attachment artifact visible to the session.`
- `Example: A run publishes a diff artifact and a terminal-output artifact. The timeline shows both manifests, but the large terminal payload requires explicit expansion.`
- `Example: A local-only artifact contains sensitive machine-specific data. The participant keeps the original artifact local and publishes a separate summarized artifact for shared discussion instead of partially redacting the original artifact in place.`

## Implementation Notes

- Artifact immutability matters more than original path convenience.
- Content-addressable storage (CAS) is keyed by SHA-256 for automatic deduplication.
- Attachment manifests should stay small enough for routine timeline and replay use.

## Pitfalls To Avoid

- Treating a live filesystem path as an immutable artifact
- Auto-sharing local artifacts with no visibility classification
- Requiring inline rendering for every artifact regardless of size

## Acceptance Criteria

- [ ] Attachment ingestion produces stable artifact ids and manifests.
- [ ] Artifacts remain readable and attributable after the producing run ends.
- [ ] Large artifacts can be represented in the timeline without forcing full inline payload rendering.

## ADR Triggers

- If the system changes the local-vs-shared artifact boundary materially, create or update `../decisions/004-sqlite-local-state-and-postgres-control-plane.md`.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: shared artifact replication is manifest-first with deferred payload transfer. Small-payload synchronous optimization does not change the external contract in v1.
- V1 decision: participant-specific fine-grained artifact redaction is out of scope for v1. Visibility remains class-based, and any redacted shareable form must be published as a separate derivative artifact.

## References

- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)
- [Data Architecture](../architecture/data-architecture.md)
