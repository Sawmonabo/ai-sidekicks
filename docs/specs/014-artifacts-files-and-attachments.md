# Spec-014: Artifacts Files And Attachments

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `014` |
| **Slug** | `artifacts-files-and-attachments` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md), [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md), [Data Architecture](../architecture/data-architecture.md) |
| **Implementation Plan** | `TBD` |

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
- Artifact visibility must be explicit and must distinguish local-only from shared-visible artifacts.
- Referencing a live workspace file is not sufficient for artifact immutability; the system must capture immutable artifact content or a content-addressed snapshot.

## Default Behavior

- Newly uploaded attachments default to local artifact storage with visibility derived from session policy.
- Artifact manifests default to storing producer, session, run, type, created time, and visibility class.
- Shared replication defaults to opt-in or policy-driven behavior rather than automatic blind sharing of all local outputs.

## Fallback Behavior

- If shared replication is unavailable, the artifact may remain local-only with manifest status `pending_replication` or equivalent.
- If the artifact payload is too large for inline timeline rendering, the timeline must show a manifest row and require explicit fetch for the payload.
- If preview generation fails, the artifact remains valid and retrievable as raw content.

## Interfaces And Contracts

- `ArtifactPublish` must return artifact id and manifest metadata.
- `ArtifactRead` must return manifest plus retrievable payload handle or inline content where appropriate.
- `ArtifactVisibilityUpdate` must require policy and authorization checks.
- `AttachmentIngest` must normalize names, media type, and size metadata.

## State And Data Implications

- Artifact manifests are durable records and part of replayable session history.
- Payload storage may differ from manifest storage, but provenance must stay intact across both.
- Artifact visibility changes must be auditable.

## Example Flows

- `Example: A participant uploads a design reference image, which becomes an immutable attachment artifact visible to the session.`
- `Example: A run publishes a diff artifact and a terminal-output artifact. The timeline shows both manifests, but the large terminal payload requires explicit expansion.`

## Implementation Notes

- Artifact immutability matters more than original path convenience.
- Content-addressable payload storage is preferred when practical.
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

- Whether shared artifact replication is always manifest-first with deferred payload upload, or sometimes synchronous for small payloads.

## References

- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)
- [Data Architecture](../architecture/data-architecture.md)
