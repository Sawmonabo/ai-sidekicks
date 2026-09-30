# Artifact Diff And Approval Model

## Purpose

Define the durable outputs of runs and the gate records that authorize sensitive actions.

## Scope

This document covers `Artifact` and `Approval`, and where a diff stands beside them.

## Definitions

- `Artifact`: an immutable produced output or record.
- Diff: a comparison between two states of a working folder or branch, read from the daemon each time Review shows it ([Spec-009 §The Diff Read](../specs/009-gitflow-pr-and-diff-attribution.md#the-diff-read)); it is not an artifact and is never stored.
- `Approval`: the durable record of a gating request and its resolution.

## What This Is

This model defines how runs publish durable outputs and how gated decisions are represented for audit and recovery.

## What This Is Not

- An artifact is not a transient live event.
- A diff is not an artifact: it is read again each time it is shown and never published.
- An approval is not merely a UI button click; it is a durable decision record.

## Invariants

- Published artifacts are immutable. Later changes create new artifacts rather than mutating prior ones.
- Every artifact has provenance that identifies the session and producing actor or run.
- Every diff names the two states it compares.
- Every approval records the requester, resolver, scope, and decision.
- An approval must not grant more authority than the original request asked for.

## Relationships To Adjacent Concepts

- `Run` produces artifacts and may request approvals.
- `RepoMount`, `Workspace`, and `Worktree` provide the filesystem or git states that a diff compares.
- Trust policy determines when an approval may be resolved. An approval is the user deciding what their agents are allowed to do, so the session's owning user is the resolver — reachable from any of their linked devices.
- `QueueItem` and `Intervention` may be blocked on approval before they take effect.

## State Model

Artifact lifecycle:

| State | Meaning |
| --- | --- |
| `pending` | The artifact has been announced but is not yet durably published. |
| `published` | The artifact is durably available and referenceable. |
| `superseded` | A newer artifact replaces it for default views, but the original remains immutable history. |

Approval lifecycle:

| State | Meaning |
| --- | --- |
| `pending` | The approval request is awaiting resolution; it waits for the person as long as it takes and never expires. |
| `approved` | The request was accepted within the granted scope. |
| `rejected` | The request was denied. |
| `canceled` | The request was withdrawn before resolution, or the run holding it ended — an interrupt, a stop or an undo — and it was canceled with the run, the cancellation recorded. |

## Example Flows

- Example: An agent finishes a plan, published as an artifact; Review reads the diff of the worktree against its base each time it is opened, and nothing about the diff is stored.
- Example: A risky write or merge action creates a pending approval. The user approves it for the current session scope from whichever device they are on, and the approval record becomes part of the session audit history.
- Example: A later run publishes a revised version of an artifact. The prior one remains immutable history but becomes `superseded` for default inspection views.

## Edge Cases

- A run may fail after publishing some artifacts. The artifacts remain valid historical outputs even when the run ends in `failed`.
- An approval never expires. When the run holding it ends before the person answers — interrupted, stopped or undone — it is canceled with the run and the cancellation is recorded, so a late answer finds a canceled request and changes nothing.
- One approval decision can cover a bounded repeated action only when the granted scope explicitly says so.

## Related Domain Docs

- [Trust And Identity](./trust-and-identity.md) — approvals are signed by user identities. A `bound` identity can sign approvals; a `revoked` or `compromised` identity cannot.

## Related Specs

- [Session Event Taxonomy And Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md)
- [Approvals Permissions And Trust Boundaries](../specs/010-approvals-permissions-and-trust-boundaries.md)
- [Live Timeline Visibility And Reasoning Surfaces](../specs/011-live-timeline-visibility-and-reasoning-surfaces.md)
- [Artifacts Files And Attachments](../specs/012-artifacts-files-and-attachments.md)

## Related ADRs

- [Device Trust and Permission Model](../decisions/007-device-trust-and-permission-model.md)
