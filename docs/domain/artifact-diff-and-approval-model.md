# Artifact Diff And Approval Model

## Purpose

Define the durable outputs of runs and the gate records that authorize sensitive actions.

## Scope

This document covers `Artifact`, `DiffArtifact`, and `Approval`.

## Definitions

- `Artifact`: an immutable produced output or record.
- `DiffArtifact`: a specialized artifact that captures a change between two states.
- `Approval`: the durable record of a gating request and its resolution.

## What This Is

This model defines how runs publish durable outputs and how gated decisions are represented for audit and recovery.

## What This Is Not

- An artifact is not a transient live event.
- A diff artifact is not the repository itself.
- An approval is not merely a UI button click; it is a durable decision record.

## Invariants

- Published artifacts are immutable. Later changes create new artifacts rather than mutating prior ones.
- Every artifact has provenance that identifies the session and producing actor or run.
- Every diff artifact identifies the compared source and target states.
- Every approval records the requester, resolver, scope, and decision.
- An approval must not grant more authority than the original request asked for.

## Relationships To Adjacent Concepts

- `Run` produces artifacts and may request approvals.
- `RepoMount`, `Workspace`, and `Worktree` provide the filesystem or git states that diff artifacts compare.
- `Participant` membership and trust policy determine who can resolve approvals.
- `QueueItem` and `Intervention` may be blocked on approval before they take effect.

## State Model

Artifact lifecycle:

| State        | Meaning                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------- |
| `pending`    | The artifact has been announced but is not yet durably published.                           |
| `published`  | The artifact is durably available and referenceable.                                        |
| `superseded` | A newer artifact replaces it for default views, but the original remains immutable history. |

Approval lifecycle:

| State      | Meaning                                                 |
| ---------- | ------------------------------------------------------- |
| `pending`  | The approval request is awaiting resolution.            |
| `approved` | The request was accepted within the granted scope.      |
| `rejected` | The request was denied.                                 |
| `expired`  | The request was not resolved in time or became invalid. |
| `canceled` | The request was withdrawn before resolution.            |

## Example Flows

- Example: A coding run publishes a patch summary artifact, then a diff artifact comparing the worktree before and after the run.
- Example: A risky write or merge action creates a pending approval. A participant with authority approves it for the current session scope, and the approval record becomes part of the session audit history.
- Example: A later run publishes a refined diff artifact. The prior diff remains in history but becomes `superseded` for default inspection views.

## Edge Cases

- A run may fail after publishing some artifacts. The artifacts remain valid historical outputs even when the run ends in `failed`.
- An approval can expire because the target run already ended or the workspace context changed before resolution.
- One approval decision can cover a bounded repeated action only when the granted scope explicitly says so.

## Related Domain Docs

- [Trust And Identity](./trust-and-identity.md) — approvals are signed by participant identities. A `bound` identity can sign approvals; a `revoked` or `compromised` identity cannot. The dual-signed `ApprovalRecord` envelope per [Spec-024](../specs/024-cross-node-dispatch-and-approval.md) is the cross-node cousin of the same property.

## Related Specs

- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)
- [Live Timeline Visibility And Reasoning Surfaces](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md)
- [Artifacts Files And Attachments](../specs/014-artifacts-files-and-attachments.md)

## Related ADRs

- [Collaboration Trust And Permission Model](../decisions/007-collaboration-trust-and-permission-model.md)
