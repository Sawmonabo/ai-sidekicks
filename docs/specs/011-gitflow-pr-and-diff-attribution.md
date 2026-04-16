# Spec-011: Gitflow PR And Diff Attribution

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `011` |
| **Slug** | `gitflow-pr-and-diff-attribution` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md), [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md), [Worktree Lifecycle And Execution Modes](../specs/010-worktree-lifecycle-and-execution-modes.md) |
| **Implementation Plan** | [Plan-011: Gitflow PR And Diff Attribution](../plans/011-gitflow-pr-and-diff-attribution.md) |

## Purpose

Define the branch, PR, and diff-attribution behavior for repo-bound coding runs.

## Scope

This spec covers branch strategy, PR preparation, diff artifacts, and attribution quality levels.

## Non-Goals

- Code review workflow semantics beyond diff publication
- Git hosting vendor-specific features
- Merge automation policy

## Domain Dependencies

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Required Behavior

- Every writable coding run in `branch`, `worktree`, or `ephemeral clone` mode must execute against an explicit branch context.
- The git engine must track base branch, head branch, and worktree association for each writable coding context.
- Diff artifacts must carry provenance to the producing run when that attribution is available.
- DiffArtifact is a specialized artifact with `artifactType: "diff"` in the shared manifest envelope (defined in Spec-014).
- When precise run attribution is unavailable, the system must emit a clearly labeled workspace-level diff artifact rather than implying precise run attribution.
- Code attribution uses Agent Trace standard + git trailers (`Agent-Run: <run-id>`, `Co-authored-by: <agent-name>`) for both commit-level and line-level provenance.
- PR preparation must use the recorded base and head branch context rather than inferring it from the currently selected client tab.
- Commit, push, and PR preparation actions must be reviewable before execution.

## Default Behavior

- The default PR target branch is the worktree's recorded base branch.
- The default attribution mode is `run_attributed` when the daemon can correlate a diff to run provenance.
- `read-only` runs do not produce writable branch context or PR-preparation side effects.
- If multiple commits occur within one worktree during one run lineage, the system may prepare one cumulative PR by default.

## Fallback Behavior

- If precise attribution fails, the system must emit `workspace_fallback` diff artifacts with explicit labeling.
- If git hosting integration is unavailable, the system must still produce a PR-ready branch summary and diff artifact bundle.
- If the current branch is already checked out in an incompatible execution context, the system must require explicit user choice before proceeding.

## Interfaces And Contracts

- `BranchContextRead` must expose base, head, upstream, and worktree association.
- `DiffArtifactCreate` must identify attribution mode and compared states.
- `PRPrepare` must generate a reviewable proposal before any remote mutation.
- `GitActionExecute` must preserve causation to the requesting run or participant.
- Git hosting uses a `GitHostingAdapter` interface with `gh` CLI as the V1 implementation. Normalized terminology: `createChangeRequest` (not `createPullRequest`). Auto-detect provider from git remote URL. See [Git Hosting Adapter](#git-hosting-adapter) below for full details.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Branch and PR metadata belong to daemon-owned git projections.
- Diff artifacts must store attribution mode, provenance, and compared-state identifiers.
- The `diff_artifacts` table references `artifact_manifests` via foreign key. Plan-014 (artifacts) is a dependency of Plan-011 (git flow).
- Reviewable git actions require durable audit records.

## DiffArtifact and General Artifact Relationship

DiffArtifact is a SUBTYPE of the general artifact system defined in Spec-014. Every DiffArtifact IS an artifact -- it appears in artifact listings, has visibility control, content hashing, and all other artifact capabilities.

Schema relationship:
- The `diff_artifacts` table uses `artifact_manifests` (Plan-014) as its manifest, linked by a foreign key: `diff_artifacts.artifact_manifest_id -> artifact_manifests.id`.
- The corresponding `artifact_manifests` row carries `artifact_type = 'diff'` and the OCI-inspired manifest envelope (id, sessionId, runId, digest, size, artifactType, annotations, subject, createdAt).
- The `diff_artifacts` table adds extension columns specific to diff provenance: `attribution_mode`, `base_ref`, `head_ref`.

This subtype pattern means diff artifacts inherit all general artifact behaviors (deduplication via `content_hash`, visibility classes `local-only`/`shared`, state lifecycle `pending`/`published`/`superseded`, payload refs via `artifact_payload_refs`) without duplicating that infrastructure.

### Implementation Ordering

Plan-014 (general artifacts) MUST be implemented before Plan-011 (diff artifacts). Both reside in Tier 7 of the canonical build order, but Plan-011 declares a dependency on Plan-014 in its plan header.

The foreign key constraint `diff_artifacts.artifact_manifest_id REFERENCES artifact_manifests(id)` enforces this at the schema level: the `artifact_manifests` table must exist before `diff_artifacts` rows can be inserted.

### Artifact Storage Mechanism

Artifact content is stored outside the SQLite database using content-addressed storage (CAS).

**Local artifacts:**
- Filesystem CAS keyed by SHA-256 hash of the artifact content.
- Storage path: `<data_dir>/artifacts/<hash[0:2]>/<hash>` (first two hex characters as a directory prefix for fan-out).
- The `artifact_payload_refs.storage_path` column records this CAS key.

**Shared artifacts:**
- Blob store with an OCI-inspired manifest envelope.
- The `artifact_manifests` table stores the manifest metadata (including `content_hash` for deduplication).
- The `artifact_payload_refs` table stores the storage path or blob reference.

**Deduplication:**
- Identical content (same SHA-256 hash) produces the same CAS key, avoiding duplicate storage.
- The `artifact_manifests.content_hash` index enables fast lookup of existing content before writing.

## Git Hosting Adapter

**V1 Decision:** The default git hosting tool is `gh` (GitHub CLI).

**Rationale:**
- All reference applications use GitHub as the git hosting provider.
- `gh` is well-maintained by GitHub and covers the operations needed for V1: PR creation, status checks, diff retrieval, and commenting.
- `gh` supports auth delegation via `gh auth`, avoiding the need for the daemon to manage OAuth tokens or personal access tokens directly.
- The adapter wraps `gh` CLI calls rather than using the GitHub REST API directly. This avoids token management complexity in V1 -- the daemon delegates authentication entirely to the user's existing `gh auth` session.

### GitHostingAdapter Interface

The adapter uses host-agnostic naming (`ChangeRequest` rather than `PullRequest`) so the interface can support future hosting providers without breaking callers.

| Operation | Description | Wraps (`gh` V1) |
| --- | --- | --- |
| `createChangeRequest(params)` | Creates a PR. Params: `baseBranch`, `headBranch`, `title`, `description`, `reviewers?` | `gh pr create` |
| `updateChangeRequest(params)` | Updates PR metadata (title, description, reviewers, labels). | `gh pr edit` |
| `listChangeRequests(params)` | Lists PRs for a repo, with optional state and label filters. | `gh pr list` |
| `getChangeRequestStatus(params)` | Returns PR status: open/merged/closed plus CI check results. | `gh pr view` |
| `addComment(params)` | Adds a comment to an existing PR. | `gh pr comment` |

All operations accept a `repoMountId` to identify the target repository context and return structured results (not raw CLI output). The adapter parses `gh` JSON output (`--json` flag) into typed response objects.

### Multi-Host Path (V2)

V1 ships with GitHub (`gh` CLI) only. The following adapters are documented as future work:

- **GitLab adapter:** Wraps `glab` CLI or the GitLab REST API. `glab` provides a similar CLI experience to `gh` for merge request operations.
- **Bitbucket adapter:** Wraps the Bitbucket REST API directly. There is no widely-used CLI equivalent for Bitbucket, so the adapter would use HTTP calls.

The `GitHostingAdapter` interface is designed to be host-agnostic -- all methods use generic `ChangeRequest` terminology, and callers never reference GitHub-specific concepts. Adding a new hosting provider requires implementing the interface without changing any calling code.

See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for the typed `GitHostingAdapter` interface definition.

## Example Flows

- `Example: A coding run edits files in a worktree, publishes a run-attributed diff artifact, and later prepares a PR against the recorded base branch.`
- `Example: Attribution metadata is incomplete after a recovery path. The system publishes a workspace fallback diff artifact and labels it as such in the timeline.`

## Implementation Notes

- Attribution quality is a first-class field, not an inferred UI decoration.
- PR preparation and diff production are related but distinct operations.
- Head or base branch changes after worktree creation must be explicit updates to the stored branch context.

## Pitfalls To Avoid

- Pretending workspace diffs are run-attributed when they are not
- Inferring PR base or head from transient client state
- Mutating remote git state without a reviewable preparation step

## Acceptance Criteria

- [ ] Writable coding runs in `branch`, `worktree`, or `ephemeral clone` mode always have an explicit branch context.
- [ ] Diff artifacts distinguish run-attributed and workspace-fallback attribution modes.
- [ ] PR preparation produces a reviewable proposal tied to base and head branch context.

## ADR Triggers

- If the system abandons worktree-centered gitflow as the default coding path, create or update `../decisions/006-worktree-first-execution-mode.md`.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: stacked PR workflows are deferred. The first release supports single-branch, single-PR proposal flow only.

## References

- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)
- [Worktree Lifecycle And Execution Modes](../specs/010-worktree-lifecycle-and-execution-modes.md)
- [Spec-014](./014-artifacts-files-and-attachments.md)
