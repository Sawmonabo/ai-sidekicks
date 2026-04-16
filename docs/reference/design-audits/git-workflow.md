# Doc Review: Git Flow, Workflow, Artifact, and Approval Documentation

Date: 2026-04-14

**Staleness note:** This audit predates the 2026-04-15 batch update. Claims that Spec-017 lacks phase/gate types and Spec-012 lacks an approval enum are now resolved. See current canonical docs.

Scope: Specs 009, 010, 011, 012, 014, 017; Plans 009, 011, 012, 014, 017; Domain models repo-workspace-worktree and artifact-diff-approval; ADRs 004 and 006. Compared against the Forge feature audit where relevant.

---

## 1. What the Docs Specify

### Repo Attach and Git Flow (Signature Feature 4)

The documentation covers a full lifecycle from repository attachment through workspace binding, worktree-based execution, diff attribution, and PR preparation.

**Entity model.** Three primary entities form the chain: `RepoMount` (a repository attached to a session), `Workspace` (a session-bound execution context rooted at a directory or checkout), and `Worktree` (an isolated checkout derived from a repository and used as a write target). These are defined in "Repo Workspace Worktree Model" under "Definitions."

**Execution mode taxonomy.** Four canonical modes are defined in the domain model under "Execution Mode Model": `read-only`, `branch`, `worktree`, and `ephemeral clone`. Default writable coding mode is `worktree` (ADR-006).

**State transitions.** Three separate lifecycle tables are specified in the domain model under "Lifecycle":
- RepoMount: `attached` -> `detached` -> `archived`
- Workspace: `provisioning` -> `ready` -> `busy` -> `stale` -> `archived`
- Worktree: `creating` -> `ready` -> `dirty` -> `merged` -> `retired` -> `failed`

**Branch strategy.** Spec-010 "Default Behavior" defines the default branch naming pattern as `sidekicks/<session-short-id>/<task-slug>`. One dedicated worktree per active task or branch context is the default.

**Diff attribution.** Spec-011 "Required Behavior" defines two attribution modes: `run_attributed` (when the daemon can correlate a diff to run provenance) and `workspace_fallback` (when precise attribution is unavailable). Attribution quality is a first-class field.

**PR preparation.** Spec-011 "Required Behavior" requires PR preparation to use recorded base and head branch context rather than inferring from client state. A reviewable proposal must be generated before any remote mutation. Default PR target is the worktree's recorded base branch. V1 supports single-branch, single-PR flow only (stacked PRs deferred).

### Workflow Orchestration

**Workflow definitions.** Spec-017 "Required Behavior" requires workflows to be authored as explicit phase definitions with stable ids and versioned structure. Definitions are first-class durable records, not artifacts. Editing creates a new version rather than mutating a running definition.

**Phase execution.** Phases default to sequential execution unless the definition explicitly marks safe parallelism. Each phase defaults to one primary target channel and one primary producing run. A phase may create runs, request approvals, emit artifacts, or block on participant input.

**Gates and resumption.** Workflow gates are resolved via `WorkflowGateResolve`. Execution must be resumable after daemon restart or client reconnect. If a later phase depends on unavailable capabilities, the workflow pauses in a blocked state.

**Phase outputs.** Phase outputs must be durable and addressable after workflow completion, stored as artifact references or equivalent durable output records linked to workflow version and phase id.

---

## 2. Repo/Workspace/Worktree Model Assessment

**RepoMount -> Workspace -> Worktree relationship: well-specified.** The domain model clearly establishes the containment chain under "Invariants": every repo mount belongs to exactly one session, a workspace must resolve to one concrete filesystem root, a worktree must belong to one repo mount, and every repo-bound run binds to exactly one execution mode. The "What This Is Not" section explicitly disambiguates: a repo mount is not itself a workspace, a workspace is not automatically a git worktree, and a worktree is not a branch name.

**Execution modes: well-defined.** The four-mode taxonomy is specified with a clear table in the domain model under "Execution Mode Model" and reinforced by ADR-006. Spec-010 adds operational detail: `read-only` prohibits mutation, `branch` is explicit writable override using existing checkout, `worktree` is default writable coding mode with isolation, and `ephemeral clone` provisions a disposable clone. Spec-010 "Required Behavior" explicitly prohibits silent fallback from worktree to main checkout and silent substitution between modes.

**Gap: Workspace-to-Worktree binding mechanics.** The domain model says a workspace "must resolve to one concrete filesystem root at execution time," but the exact mapping when a workspace switches from read-only to worktree mode is not fully spelled out. Spec-009 "Example Flows" shows the workspace remaining "the same session-bound concept" while the daemon provisions an isolated execution root, but the state-machine transitions that govern this (does the workspace go through `provisioning` again? does a new workspace get created?) are underspecified.

**Gap: Ephemeral clone cleanup.** Spec-010 "Interfaces And Contracts" mentions `EphemeralClonePrepare` must report cleanup policy, but no cleanup lifecycle states are defined. The worktree lifecycle table covers `retired` and `failed`, but ephemeral clones are not worktrees. The domain model says ephemeral clone "is an execution mode, not a separate top-level domain object," which means its lifecycle piggybacks on workspace states, but no explicit disposal or garbage-collection behavior is specified.

---

## 3. Git Flow and Diff Attribution Assessment

**Branch strategy: specified.** Default naming (`sidekicks/<session-short-id>/<task-slug>`) is locked for v1 per Spec-010 "Open Questions." Branch context persistence (base, head, upstream, worktree association) is required by Spec-011 "Interfaces And Contracts" via `BranchContextRead`. Plan-011 "Data And Storage Changes" adds `branch_contexts` table.

**Diff attribution per run: specified.** Two quality levels (`run_attributed` and `workspace_fallback`) are defined in Spec-011. Plan-011 targets `diff_artifacts` and `branch_contexts` tables. The spec requires attribution mode to be a first-class field, not inferred UI decoration.

**PR preparation: specified at contract level.** `PRPrepare` must generate a reviewable proposal before remote mutation. Plan-011 adds `pr_preparations` table. Rollout order is incremental: branch context and diff artifacts first, then read-only review surfaces, then PR preparation and remote mutation handoff.

**Comparison against Forge.** Forge already implements:
- Branch/worktree toolbar with thread-bound worktree creation (Forge audit section 4: "Branch/worktree toolbar")
- Agent-attributed diffs vs full-workspace diffs with fallback (Forge audit section 4: "Diff modes" and "Diff fallbacks" -- "Agent diffs can fall back to workspace snapshots when attribution coverage is unavailable")
- Commit review dialog with file include/exclude and new-branch option (Forge audit section 4: "Commit review dialog")
- Git quick action menu with init, commit, push, PR creation (Forge audit section 4: "Git quick action menu")
- Branch selector with create-branch, worktree reuse, and PR checkout parsing (Forge audit section 4: "Branch selector")
- Git guardrails on default-branch actions (Forge audit section 4: "Git guardrails")
- Configurable worktree branch prefix in settings (Forge audit section 1: "General client settings")

**Gap vs Forge: the ai-sidekicks specs do not specify several behaviors Forge already ships.**
- No mention of PR checkout parsing from URLs or `gh pr checkout` commands (Forge: "Branch selector" supports `#123`, GitHub URLs, or `gh pr checkout`)
- No mention of worktree bootstrap scripts that run automatically on creation (Forge: "Worktree bootstrap scripts"). In fact, Spec-010 explicitly defers this: "v1 must surface them as explicit follow-on actions"
- No mention of stacked git actions or composite push+PR flows (Forge: "Git quick action menu" exposes "composite stacked actions")
- No mention of route-addressable diff state (Forge: "Route-addressable diff state" encodes diff mode, selected turn, and selected file in route search params)
- No mention of git text-generation model settings for commit messages (Forge: "General client settings" exposes "git text-generation model settings")

---

## 4. Workflow Model Assessment

**Authoring: specified.** Workflow definitions are first-class durable records with stable ids and versioned structure. Definitions are session-scoped or project-scoped in v1 (global libraries deferred). Immutable-by-version semantics: editing creates new version. Plan-017 targets `workflow_definitions`, `workflow_versions`, `workflow_runs`, `workflow_phase_states`, and workflow-gate records.

**Phase types: underspecified.** Spec-017 says a phase "may create runs, request approvals, emit artifacts, or block on participant input," but does not enumerate concrete phase types. The domain dependency on "Agent Channel And Run Model" suggests phases map to runs, but the spec does not define a phase-type taxonomy.

**Comparison against Forge.** Forge already implements concrete phase execution modes (Forge audit section 3: "Phase execution modes" -- "Each phase supports single-agent, multi-agent deliberation, automated, and human modes"). The ai-sidekicks Spec-017 does not define these phase types at all.

**Gates and quality checks: underspecified.** Spec-017 mentions `WorkflowGateResolve` and that a phase may "request approvals," but does not define gate types, failure behavior, or retry semantics. Forge already ships gate and quality-check controls (Forge audit section 3: "Gate and quality-check controls" -- "Phases can define post-phase gates, failure behavior, retry targets, max retries, and per-phase quality checks"). None of this detail appears in the ai-sidekicks spec or plan.

**Human approval in workflows: underspecified.** Forge has a concrete human approval gate UI (Forge audit section 3: "Human approval gate UI" -- "Waiting-human phases surface approval summaries, quality-check results, correction text, and approve/correct/reject actions"). Spec-017 only says a phase may "request approvals" and that gates exist.

**Workflow output modes: not specified.** Forge supports conversation markdown, channel transcripts, and structured JSON drill-down for phase outputs (Forge audit section 3: "Workflow output modes"). Spec-017 says only that phase outputs must be "durable and addressable."

**Gap: no discussion model.** Forge has a full discussion authoring system with multi-participant roles and models (Forge audit section 3: "Discussion authoring"). The ai-sidekicks docs mention multi-agent orchestration as a dependency (Spec-016) but the reviewed specs do not define discussion semantics.

---

## 5. Approval and Trust Model Assessment

**Permission scopes: well-defined.** Spec-012 "Required Behavior" distinguishes four authorization layers: session membership, runtime-node trust, run-level approval policy, and tool/resource-level permission grants.

**Membership roles: specified.** At least `viewer`, `collaborator`, `runtime contributor`, and `owner` (Spec-012 "Required Behavior").

**Approval types: specified at contract level.** `ApprovalRequestCreate` includes category, scope, requested resource, and expiry policy. Sensitive actions include destructive git operations, out-of-boundary file writes, unrestricted network access, and high-risk tool execution (Spec-012 "Required Behavior").

**Trust boundaries: well-defined.** Session membership does not imply local execution authority. A participant's own runtime node is trusted within its declared envelope but does not grant authority to other participants or waive approval for sensitive escalation. If node ownership cannot be established, strict per-request approval is required (Spec-012 "Fallback Behavior").

**Remembered grants: specified.** Off by default, require explicit opt-in, include revocation paths and audit history. Invalidated when membership or node trust changes (Spec-012 "Fallback Behavior" and "State And Data Implications").

**Multi-user handling: adequate for v1.** The spec covers cross-participant trust boundaries, role-based resolution authority, and the principle that membership is not execution trust. Plan-012 targets `approval_requests`, `approval_resolutions`, and `remembered_approval_rules` tables with invalidation hooks.

**Gap: no approval category enumeration.** Spec-012 says categories include "at least destructive git operations, out-of-boundary file writes, unrestricted network access, and high-risk tool execution," but does not provide the canonical enum. Plan-012 step 1 defers this to "define canonical approval categories, scope enums," meaning the spec delegates enumeration to implementation.

**Comparison against Forge.** Forge implements per-turn and per-session permission grants with selectable read/write paths and network toggle (Forge audit section 2: "Permission-request UX"). The ai-sidekicks spec covers similar ground but with more formal trust-boundary semantics and remembered-grant invalidation that Forge may not yet have.

---

## 6. Spec and Plan Completeness

| Document | Implementable? | Assessment |
|---|---|---|
| Spec-009 (Repo Attach) | Yes | Clear required behavior, explicit interfaces, acceptance criteria. Enough to implement repo mount and workspace binding. |
| Plan-009 | Yes | Target areas, tables, rollout order, and parallelization guidance are present. |
| Spec-010 (Worktree Lifecycle) | Yes | Detailed execution-mode contracts, fallback behavior, branch naming. Strong. |
| Spec-011 (Git Flow / PR / Diff) | Mostly | Attribution modes and PR preparation contracts are clear. Missing: PR template structure, commit message generation, hosting integration specifics. |
| Plan-011 | Yes | Clear implementation steps and parallelization. Missing: no mention of git hosting adapter abstraction. |
| Spec-012 (Approvals) | Mostly | Trust model is strong. Missing: canonical approval category enum and concrete scope definitions. |
| Plan-012 | Yes | Clear steps. Defers enum definition to implementation, which is workable. |
| Spec-014 (Artifacts) | Yes | Immutability, visibility, manifest-first semantics are clear. Content-addressed storage is preferred but not required. |
| Plan-014 | Yes | Clear steps. Risk section correctly flags manifest-first vs synchronous small-payload tension. |
| Spec-017 (Workflows) | Partially | Phase definition semantics, gate types, quality checks, and phase execution modes are all underspecified compared to what Forge already ships. |
| Plan-017 | Partially | Follows spec faithfully but inherits its gaps. Would benefit from phase-type taxonomy before implementation. |

---

## 7. Internal Consistency

**ADR status vs spec approval: process gap.** Both ADR-004 and ADR-006 have status `proposed` with "Reviewers: Pending assignment." Every spec that depends on them is already `approved`. Every plan that requires them has the ADR acceptance checkbox unchecked. This means the specs were approved before their prerequisite architectural decisions were formally accepted. This is a process integrity issue: specs should not reach `approved` while their required ADRs remain `proposed`.

**Term consistency: good overall.** The four execution modes (`read-only`, `branch`, `worktree`, `ephemeral clone`) are used consistently across all documents. `RepoMount`, `Workspace`, and `Worktree` are consistently defined and referenced.

**Minor term drift: "execution root" vs "workspace root."** Spec-009 uses "execution root" in workspace binding. Spec-010 uses "execution root" for the filesystem target prepared by `ExecutionRootPrepare`. The domain model says workspace "must resolve to one concrete filesystem root." These are the same concept under slightly different names, but no canonical term is pinned.

**Artifact vs workflow definition boundary: explicitly guarded.** Spec-017 and Plan-017 both repeatedly state that workflow definitions are first-class persisted records and that artifact publication is derivative only. This is consistent and well-enforced.

**DiffArtifact dual identity.** The domain model "Artifact Diff And Approval Model" defines `DiffArtifact` as a specialized artifact. Spec-011 defines `DiffArtifactCreate`. Spec-014 defines the general artifact system. The relationship is clear but the two specs do not cross-reference each other's handling. Plan-011 creates `diff_artifacts` table while Plan-014 creates `artifact_manifests` and `artifact_payload_refs`. It is unclear whether diff artifacts share the general artifact manifest infrastructure or have a parallel schema.

**Spec-010 missing from the review list.** Spec-010 (Worktree Lifecycle and Execution Modes) is a critical dependency of Spec-011 and the domain model but was not in the original document set for this review. It exists and is `approved`. Much of the worktree lifecycle detail lives there, not in Spec-009 or the domain model.

---

## 8. Open Questions and Critical Gaps

### Must resolve before implementation

1. **ADR acceptance.** ADR-004 and ADR-006 must be formally accepted. All plans list them as required, and all checkboxes are unchecked. Implementation should not begin with prerequisite decisions still in `proposed` status.

2. **Phase-type taxonomy for workflows.** Spec-017 does not define phase execution modes. Forge ships four (single-agent, multi-agent deliberation, automated, human). The ai-sidekicks spec must enumerate phase types, their contracts, and their relationship to runs and channels before workflow implementation begins.

3. **Gate and quality-check semantics.** Spec-017 mentions gates but does not define gate types, failure behavior, retry semantics, or max-retry configuration. Forge already has this. Plan-017 cannot implement gates without this specification.

4. **Diff artifact and general artifact schema relationship.** Plan-011 creates `diff_artifacts`. Plan-014 creates `artifact_manifests` and `artifact_payload_refs`. Are diff artifacts a subtype using the general manifest infrastructure, or a parallel schema? Implementation order matters (Plan-014 is a dependency of Plan-011 if they share infrastructure).

5. **Workspace-to-worktree binding state transitions.** When a workspace goes from read-only to worktree mode, what states does the workspace traverse? Is it `ready` -> `provisioning` -> `busy`? Or does a new workspace entity get created? The domain model and Spec-009 leave this ambiguous.

### Should resolve before v1 ship

6. **Ephemeral clone cleanup lifecycle.** No disposal or garbage-collection behavior is specified for ephemeral clones.

7. **Git hosting adapter abstraction.** Plan-011 non-goals exclude "Full GitHub or git-host integration breadth," but PR preparation inherently requires some hosting integration. No adapter interface is specified.

8. **Canonical approval category enum.** Spec-012 lists minimum categories but delegates the actual enum to implementation. This should be specified to ensure consistent behavior across daemon implementations.

9. **Worktree bootstrap scripts.** Forge ships automatic worktree bootstrap scripts. Spec-010 explicitly defers this for v1. This is a known gap that will surface as user friction.

10. **PR template and commit message generation.** Spec-011 covers PR preparation at the contract level but says nothing about PR body templates, commit message generation, or model-assisted git text generation. Forge already ships a git text-generation model setting.
