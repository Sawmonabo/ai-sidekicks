# ADR-015: V1 Feature Scope Definition

| Field         | Value                   |
| ------------- | ----------------------- |
| **Status**    | `accepted`              |
| **Type**      | `Type 1 (two-way door)` |
| **Domain**    | `Scope / Product`       |
| **Date**      | `2026-04-17`            |
| **Author(s)** | `Claude (AI-assisted)`  |
| **Reviewers** | `Accepted 2026-04-17`   |

## Context

The product vision (`docs/vision.md`) positions this system as an agentic coding runtime for one user and their agents, with multi-agent sessions, a desktop-plus-CLI client story, and control of a running session from any linked device as the defining claims.

Two of the vision's claims bear directly on what V1 must contain:

1. **Multi-agent orchestration (Spec-014)** — several agents working in one session, a lead running helpers as child runs under the person's budgets and a per-agent turn limit, is a signature feature of the vision, and the product positions itself against commodity single-agent CLI runners on exactly this axis; V1 must include it or the category-positioning claim does not match what ships.
2. **Desktop GUI** — the vision build order lists desktop as step 6 of V1 delivery, and the product differentiates against CLI-only offerings (Claude Code, Codex CLI, Aider) in part through a richer desktop surface; V1 must include it for the same reason.

The implementation plans and the cross-cutting specs need one authoritative V1 scope source, which the plans and `docs/architecture/cross-plan-dependencies.md` follow. This ADR is that source.

## Problem Statement

What features compose the V1 release of the product, and what is out of scope for it?

### Trigger

The plans and the cross-cutting specs cite one V1 scope, and that scope has to carry the vision's positioning claims.

## Decision

V1 consists of **21 features**, and nothing is deferred to a later release. What exists only to sell to or govern an organization of other people is out of scope for a product with one user (see §Out of Scope below).

### V1 Features (21)

| # | Feature | Governing Spec(s) |
| --- | --- | --- |
| 1 | Session creation | [Spec-001](../specs/001-session-core.md) |
| 4 | Machine registration | [Spec-002](../specs/002-runtime-node-attach.md): the machine that runs your sessions, which the backend calls a runtime node, registers once with the control plane, keyed by the machine and its owner, and is reached through the relay; it is reachable while its relay connection is up, and a session never moves to another machine |
| 5 | Single-agent runs (Codex, Claude) | [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) |
| 6 | Queue, steer, pause, resume, interrupt | [Spec-003](../specs/003-queue-steer-pause-resume.md) |
| 7 | Approval gates | [Spec-010](../specs/010-approvals-permissions-and-trust-boundaries.md) |
| 8 | Repo attach and workspace binding | [Spec-007](../specs/007-repo-attachment-and-workspace-binding.md) |
| 9 | Worktree-based execution | [Spec-008](../specs/008-worktree-lifecycle-and-execution-modes.md) |
| 10 | Session timeline with replay | [Spec-011](../specs/011-live-timeline-visibility-and-reasoning-surfaces.md), [Spec-013](../specs/013-persistence-recovery-and-replay.md) |
| 11 | Local daemon with CLI | [Spec-006](../specs/006-local-ipc-and-daemon-control.md) |
| 13 | Event audit log | [Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md) |
| 14 | Artifact publication | [Spec-012](../specs/012-artifacts-files-and-attachments.md): a session's artifacts stay on the machine that runs the session, which lists them on every linked device; a device reads them through Remote Control's method proxy, and the relay keeps no copy |
| 15 | Desktop GUI | [Spec-021](../specs/021-desktop-app-and-renderer.md) |
| 16 | Multi-agent orchestration | [Spec-014](../specs/014-multi-agent-orchestration.md) |
| 17 | Workflow authoring and execution (full engine) | [Spec-015](../specs/015-workflow-authoring-and-execution.md): the V1 engine covers the DAG executor, the visual builder and its node catalog — whose agent and person kinds, `agent.run`, `agent.multi-agent`, `human.approval` and `human.form`, delegate to the existing run, orchestration, approval and form machinery — parallel steps admitted by a memory gate and joined through a `flow.merge` node, the entry node’s trigger kinds, and the `workflow.*` event taxonomy across its categories. The full contract is in Spec-015 and [Plan-015](../plans/015-workflow-authoring-and-execution.md). |
| 18 | MCP server configuration and governance | [Spec-025](../specs/025-mcp-server-configuration-and-governance.md) + [Plan-025](../plans/025-mcp-server-configuration-and-governance.md): server-config CRUD, a trusted-server store, managed by the person, with Cedar-gated per-tool overrides, zero-billed-turn status and health probing, and server OAuth |
| 19 | Undo to an earlier message | [Spec-003](../specs/003-queue-steer-pause-resume.md) (the undo a person asks for — the conversation and the files, the conversation alone, or the files alone — as one request with one reported result, implemented by [Plan-003](../plans/003-queue-steer-pause-resume.md)), [Spec-013 §Required Behavior](../specs/013-persistence-recovery-and-replay.md#required-behavior) (the daemon's own file checkpoint store), [ADR-017](./017-shared-event-sourcing-scope.md) (every undo is recorded forward, as `session.restore_finished`, with `run.rolled_back` for the conversation cut — the log never truncates). The conversation goes back through the provider's own cut, Claude Code's `rewind_conversation` and Codex's `thread/revert {threadId, beforeTurnId}` ([Spec-004](../specs/004-provider-driver-contract-and-capabilities.md)), and neither touches a file; the files go back through the daemon's checkpoints, never through the git snapshot. A point before Claude Code's last compaction is reached through the provider's own copy of the conversation, resumed in place, so the session keeps its identity and no point is refused. Codex has no `thread/rollback`. |
| 20 | Session goals | [Spec-014](../specs/014-multi-agent-orchestration.md) (`/goal` gives one agent a condition to work toward until it is met, cleared or stopped unmet, through `session.goalUpdate` and `session.goalClear`; a session may have no goal, one or several over its life, and is never named or labeled by one), [Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md) (`session.goal_updated`, carrying the goal's status, and `session.goal_cleared`, each drawn only as a transcript system message) |
| 21 | Session callback tools | [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) (the daemon-registered tool shape), [Spec-010](../specs/010-approvals-permissions-and-trust-boundaries.md) (Cedar-governed identically to provider tools) |
| 22 | Execution postures and sandbox profiles | [Spec-010](../specs/010-approvals-permissions-and-trust-boundaries.md) (`executionPosture` as an authorization input), [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) (the posture shape) |
| 23 | Voice (`/voice`) | [Spec-014 §Design Decisions](../specs/014-multi-agent-orchestration.md#design-decisions) (voice ships on both providers, with no reservation and no gate), [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) (each provider's voice leg and the `voice.*` verbs), [Spec-021](../specs/021-desktop-app-and-renderer.md) (the composer's microphone capture and the voice mode kept in the machine settings file). On a Claude Code session `/voice` dictates into the composer through Anthropic's speech service, the daemon running its own socket to it for each recording; on a Codex session it runs Codex's own realtime voice call, the app window the call's WebRTC peer. On both, talking starts the same way, by holding Space or, after `/voice tap`, tapping it, and a hold on Codex reaches the call only once Space is let go. |
| 24 | Remote Control | [Spec-028](../specs/028-remote-control.md) + [Plan-028](../plans/028-remote-control.md) — a session is driven from any of the person's linked devices with full parity, while it runs on its one owning machine. The desktop app, the web client and the phone apps run one front end through one bridge interface with an implementation for each, a member a host cannot serve being absent there. On the phone and browser clients every screen folds to one column, with one back control, when the window is too narrow for its list and its detail at once; a desktop window never folds. The iPhone app ([Spec-029](../specs/029-ios-remote-client.md)) is that front end in a Capacitor wrapper, native only for the Secure Enclave key, the push extension, the cover, the scan, the port view and front-end bundle staging; it runs on iOS 26 and later and is built and signed under the person's own Apple account. |

Two behaviors inside V1 features ship whole in V1:

- **A human step's `Timeout`** (feature 17, [Spec-015](../specs/015-workflow-authoring-and-execution.md)). It is empty by default, and the step waits until it is answered. When the author sets one, it is a durable deadline on the step's row, re-armed when the step starts and checked when an answer arrives; at the deadline the step fails with `workflow.step_timed_out` (`step_timeout`) and the step's `onError` routes it. The step's receipt reads `Timed out at <time>`, and its waiting line `until <time>`. The start of a wait is its escalation: the step reaches the person the moment it begins waiting, and nothing pages later.
- **Every data act** ([Spec-020](../specs/020-data-retention-and-gdpr.md)). A session's purge is the daemon's one purge path and deletes the session's content key first, overwritten with zeros and followed by a `TRUNCATE` checkpoint after commit, so what it leaves in freed pages is ciphertext whose key is gone. `Export all data` writes a readable folder that holds no settings, credentials or keys. `Erase all data` stops all work, signs the providers out, destroys the keys and the data, and restarts empty. `sidekicks delete-account` is the one way to delete the hosted account: a person who has lost every machine installs the command-line tool on another computer, signs in with `sidekicks sign-in`, confirms with a passkey in the browser, and runs it. `sidekicks rotate-keys` replaces the master key crash-safely: every wrapped key is re-wrapped under the new key in the transaction that makes it active, and a rotation cut short resumes or rolls back at the next start. The revocation denylist is written on every revocation. There are no `gdpr.*` stub methods and no `user.exported`, `user.purge_requested` or `user.purged` events.

### Out of Scope

The product has one user, so what exists only to sell to or govern an organization of other people is out of scope: enterprise sign-on (OIDC and SAML), compliance mappings (SOC 2, ISO 27001, HIPAA, FedRAMP), HSM custody, WAF guidance, Helm charts, SLA support, multi-region sign-up discovery, and server-side telemetry. The app collects no usage analytics. The product builds no agent runtime of its own and no provider marketplace: V1 is Claude Code and Codex, and a later provider is admitted through [Spec-004 §Scope](../specs/004-provider-driver-contract-and-capabilities.md#scope)'s provider-admission contract.

### Thesis — Why This Option

The product's category positioning rests on three claims: multi-agent sessions, a desktop-plus-CLI experience, and control of a live session from any linked device. Shipping V1 without Multi-agent orchestration or Desktop GUI launches into a crowded market (Claude Code, Codex CLI, Aider, Cursor, Windsurf) without the features that justify the product's existence. Landing V1 at the full surface above rather than a narrower alternative pays the implementation cost to preserve the differentiators.

Treating Multi-agent orchestration as a V1 quality gate forces the team to harden Spec-014 — child runs and their linkage, budget defaults, the per-agent turn limit, stop conditions, goals — rather than leaving it as a spec with no build behind it. That quality work matters the moment a lead runs a helper in a session, which happens on day one of V1.

### Antithesis — The Strongest Case Against

A staff engineer looking at a pre-code project with a V1 target this broad has legitimate concern: a broad V1 is the single most common cause of greenfield project slip. Every V1 feature is a concurrent dependency in the critical path. Multi-agent orchestration in particular carries child-run, budget and turn-limit complexity that single-agent runs do not. Desktop GUI carries Electron packaging, auto-update, code-signing, and cross-platform QA burden. A narrower V1 (Option B below) launches faster, validates the agent-runtime core under real load, and adds multi-agent sessions in a later release six months on with full production data to drive the quality bar. That is how most successful platforms have shipped.

### Synthesis — Why It Still Holds

The antithesis assumes V1 launch speed is the dominant cost. For this product, launch positioning is the dominant cost. A CLI-only single-agent V1 does not survive the first launch-day comparison thread — the product would be reviewed as "another CLI agent runner, but less mature than Aider or Claude Code." The scope-size risk is real but bounded by two factors: (1) AI implementation costs (Claude Opus 4.7 executing the plans) collapse engineering-week counts relative to human-labor estimates; (2) build-order discipline via [`docs/architecture/cross-plan-dependencies.md`](../architecture/cross-plan-dependencies.md) keeps work sequenced rather than parallel-fire. The quality risk on Multi-agent orchestration is the more serious concern; the mitigation is a V1-readiness review of Spec-014 before Plan-014 is built.

## Alternatives Considered

### Option A: The chosen V1 set

- **What:** Ship the full feature list above as the V1 target.
- **Steel man:** Aligns shipped scope with vision positioning; resolves the two scope inconsistencies named in §Context; establishes one authoritative source the plans and the cross-cutting specs cite; sets the Multi-agent orchestration quality bar at V1 where it belongs.
- **Weaknesses:** Larger V1 surface = more implementation work before first ship; Multi-agent orchestration quality bar adds hardening work that would otherwise defer; Desktop GUI adds a second client track in the critical path rather than strictly after CLI proves the contract.

### Option B: The smaller set (rejected)

- **What:** Ship a narrower V1 with Desktop GUI and Multi-agent orchestration pushed to a later release.
- **Steel man:** Faster time to first-ship. CLI-first validates the typed client SDK and daemon contract before desktop-specific UX adds complexity (which matches the vision build-order recommendation for CLI as step 3 and desktop as step 6). Single-agent V1 validates the run state machine, driver contract, and approval gates under real traffic before multi-agent adds the per-agent turn limit and budget enforcement. Solo / small-team reality check: even a narrower surface is a stretch for one engineering resource, even with AI implementation.
- **Why rejected:** A CLI-only single-agent V1 launches into direct comparison with Claude Code, Codex CLI, Aider, Cursor, Windsurf, and the broader coding-agent field. Those products are mature on the CLI+single-agent axis. The category-defining claim for this product is explicitly _multi-agent, steerable, and reachable from any of the user's devices_ — vision Thesis and Product Goal both state this in the first ten lines. Shipping V1 without the category-defining features launches the product as a weaker commodity offering on the axis where it is strongest. The time-to-first-ship optimization is chasing the wrong metric for a greenfield product whose value is its positioning.

### Option C: Tiered M1–M4 milestone track (Rejected)

- **What:** Partition the V1 features into four sequential milestone releases, each a customer-facing release.
- **Steel man:** Incremental customer feedback at each milestone; reduced risk of a big-bang launch; explicit cut points for scope adjustment between milestones; operational release-pipeline discipline earned incrementally rather than all at once; easier to message "we're shipping now, more next month" than "we're still building, launch TBD."
- **Why rejected:** Adds PM overhead and customer-communication surface without reducing engineering risk for a greenfield pre-code project. Each milestone boundary requires release-pipeline investment (signing, auto-update, changelog cadence, deprecation windows) earlier than a single-target V1 requires it. The backlog already enforces build-order structure via `docs/architecture/cross-plan-dependencies.md`; that granularity is sufficient for engineering sequencing without making milestone boundaries customer-facing. Making them customer-facing is the cost; the benefit (incremental feedback) is available to any greenfield team via private beta without public M1/M2/M3 release mechanics. The milestone track also pushes the category-positioning launch to M2 or later, which re-raises the Option B problem.

## Reversibility Assessment

- **Reversal cost:** Low to Medium while pre-code. Adding a feature to V1 or removing one requires: changing this ADR, rewriting `docs/architecture/v1-feature-scope.md`, updating `docs/architecture/cross-plan-dependencies.md`, and updating the affected spec and plan. No code-migration cost before first ship; moderate doc-churn cost. Once V1 ships, removing a feature from it is higher cost.
- **Blast radius:** `docs/architecture/v1-feature-scope.md`, `docs/architecture/cross-plan-dependencies.md`, every plan file, any ADR or spec referencing a V1 label.
- **Migration path:** Replace this ADR with a new one, update every spec and plan whose scope changes, and realign `cross-plan-dependencies.md`.
- **Point of no return:** First V1 ship to users. Until then, reversal is free. After, feature-set expectations carry.

## Consequences

### Positive

- Single authoritative scope source for the plans and the cross-cutting specs.
- Shipped scope matches vision positioning on the two claims named in §Context.
- Multi-agent orchestration quality bar lands at V1 where it meets the category-positioning claim.
- Desktop GUI lands at V1 so launch positioning includes both client tracks vision names.

### Negative (accepted trade-offs)

- Larger V1 surface means more implementation work before first ship.
- The review of Spec-014 before Plan-014 is built is a V1 gate; the hardening cost is real.
- Desktop GUI adds Electron packaging, auto-update, code-signing, and cross-platform QA work to V1; carried via [ADR-016](./016-electron-desktop-app.md) (the Electron desktop app) and [Plan-021](../plans/021-desktop-app-and-renderer.md) (desktop implementation).
- Full workflow engine surface per Spec-015 (V1 feature 17) is V1 build cost — covers the DAG executor, the node catalog, parallel steps under a memory gate, the `workflow.*` event taxonomy across its categories, the SQLite persistence schema [Spec-015 §State And Data Implications](../specs/015-workflow-authoring-and-execution.md#state-and-data-implications) fixes, and the property/fuzz/load/integration/security test battery. Justified by research showing that retrofitting new step kinds, parallel execution, and durable human-step resumption after a first release is architecturally heavier than building them in: every surveyed system (Airflow, Dagger, GitHub Actions, n8n, Temporal, Argo, CircleCI) paid breaking-change cost retrofitting what V1-native would have covered additively. Three freeze-regret patterns: additive enum expansion (safe); replacement expansion (breaking, e.g., [Dagger CUE→SDK rewrite](https://dagger.io/blog/ending-cue-support/)); execution-model commitment (deprecate-within-releases). Primary sources consolidated in §Research Conducted.

### Unknowns

- V1 delivery timeline under the chosen scope — no fixed date commitment; tier discipline drives sequencing.
- Whether the Multi-agent orchestration V1 quality bar can be met without in-production traffic; the Spec-014 V1-readiness review is the primary gate.

## References

### Research Conducted

**MCP governance and realtime voice sources:**

- [MCP specification 2025-11-25 — Tools page](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) — the execution-safety surface grounding feature #18's governance gates: `execution.taskSupport` on tool definitions, and the Tools-page trust warning — "clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers" (accessed 2026-07-02; quoted verbatim). The MUST binds trust classification, not behavior derivation — the schema doc-comments phrase the same rule as hints ("should never make tool use decisions based on ToolAnnotations received from untrusted servers") — so the gates bind on the trusted-server store the person keeps, never on annotation self-claims
- [MCP blog — tool annotations (2026-03-16)](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/) — annotation-trust guidance consumed by the same gates
- [MCP Authorization (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) — the OAuth surface feature #18's `server OAuth` scope targets: OAuth 2.1 (IETF draft) with Authorization Server Metadata, Dynamic Client Registration, and Protected Resource Metadata (accessed 2026-07-02); Spec-025 pins its flow against this revision
- Feature #23's Codex leg rides Codex's own realtime surface: the `thread/realtime/*` client requests (`start`, `appendAudio`, `appendText`, `appendSpeech`, `stop`, `listVoices`) and the `thread/realtime/*` server notifications reach a connection only when it sets `initialize.capabilities.experimentalApi`, because the app-server's runtime filter (`should_skip_notification_for_connection`) silently drops every experimental notification for any other connection, and generating the schema cannot show that gate. The daemon's connection to a Codex service sets it, starts a call with `thread/realtime/start` carrying the window's WebRTC offer, and routes those notifications by `threadId` while `/voice` is on — receipts in [`docs/reference/provider-wire/codex.md`](../reference/provider-wire/codex.md), regenerated from the pinned binary via `codex app-server generate-json-schema`, upstream [openai/codex](https://github.com/openai/codex). The Claude Code leg is dictation through Anthropic's speech service, done as Claude Code's own VS Code extension does it.

Feature 17 (workflow authoring and execution) is grounded in primary-source evidence across seven research dimensions: parallel execution (Pass A — DAG executor, resource pools, parallel join policy), multi-agent ownership and sub-workflow lifecycle (Pass B), event taxonomy (CloudEvents / OpenTelemetry / Temporal — anchors SA-18/19/20), persistence patterns (Pass G — SQLite WAL), test infrastructure (fast-check, Jazzer.js — anchors SA-29), freeze-regret evidence from other systems' later releases (Pass D — 7-system V1-shipping-pattern survey backing the full-engine-at-V1 thesis), and security invariants I1–I7 (Pass E — CVE corpus per invariant). Cross-Pass duplications (CloudEvents, OpenTelemetry semconv, Temporal events) are cited once with the broadest-applicable Pass framing. Additional Pass C (human-phase UX), Pass F (event-taxonomy detail), Pass G (persistence-pattern detail), and Pass H (testing-strategy detail) primaries are in [Spec-015 §References](../specs/015-workflow-authoring-and-execution.md#references) and [Plan-015 §References](../plans/015-workflow-authoring-and-execution.md#references).

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| CloudEvents v1.0.2 specification | Specification (CNCF) | Envelope additive-bump rules anchor SA-18 (workflow event envelope additive MINOR bump); subject field carries workflow-run scoping | <https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md> |
| OpenTelemetry Semantic Conventions for Events | Specification (CNCF) | Event-name hierarchical convention anchors SA-19 (`workflow.<resource>.<lifecycle>` naming) | <https://github.com/open-telemetry/semantic-conventions/blob/main/docs/general/events.md> |
| Temporal Events Reference | Documentation | Reserved-event taxonomy (`WorkflowExecutionStarted`, `ActivityTaskScheduled`, etc.) anchors SA-20 reserved-event list and projection-rebuild contract | <https://docs.temporal.io/references/events> |
| SQLite Write-Ahead Logging | Specification (SQLite) | WAL-mode durability and `synchronous=FULL` rationale for the workflow persistence schema (Pass G) | <https://www.sqlite.org/wal.html> |
| fast-check (model-based property testing) | Code (MIT) | Property-test framework anchoring SA-29 test-category battery (property/fuzz/load/integration/security-regression) | <https://github.com/dubzzz/fast-check> |
| Jazzer.js (coverage-guided fuzzing for Node.js) | Code (Apache-2.0) | Fuzz-test framework anchoring SA-29 fuzz-target category for parameter-substitution and event-envelope parsing | <https://github.com/CodeIntelligenceTesting/jazzer.js> |
| OWASP File Upload Cheat Sheet | Specification (OWASP) | SA-26 form-state lifecycle | <https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html> |
| Apache Airflow `dag.py` source | Code (Apache-2.0) | Kahn's-algorithm topological-sort DAG executor precedent anchoring C-3 (DAG executor) | <https://github.com/apache/airflow/blob/main/airflow-core/src/airflow/models/dag.py> |
| Apache Airflow Pools | Documentation | Slot-based concurrency pools anchoring SA-3 (resource pools) | <https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html> |
| Astronomer — Managing Dependencies (Airflow trigger rules) | Documentation | Trigger-rules taxonomy (`all_success`, `one_failed`, etc.) anchoring C-3 (DAG executor) trigger semantics | <https://www.astronomer.io/docs/learn/managing-dependencies> |
| Temporal Go SDK (workflow primitives) | Documentation | Durable-execution primitive precedent anchoring C-3 (DAG executor) and C-7 (sub-workflow contract) | <https://docs.temporal.io/develop/go> |
| Argo Workflows — Parallelism | Documentation | Workflow-level parallelism cap anchoring SA-3 (resource pools) parallelism budget | <https://argo-workflows.readthedocs.io/en/latest/parallelism/> |
| Dagster Run Concurrency | Documentation | Multi-tier resource-pool precedent (run-tags + concurrency keys) anchoring SA-3 (resource pools) | <https://docs.dagster.io/guides/operate/managing-concurrency> |
| AWS Step Functions — Error Handling | Documentation | `Catch` / `Retry` semantics behind a step's `onError` and `retry` | <https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html> |
| Temporal — ParentClosePolicy | Documentation | Child-workflow lifecycle on parent close anchors SA-6 (multi-agent ownership) | <https://docs.temporal.io/develop/typescript/child-workflows#parent-close-policy> |
| n8n — `executeWorkflow` node | Documentation | Sub-workflow precedent anchoring C-7 (sub-workflow contract) industry alignment | <https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow/> |
| Activepieces Sub Flows | Documentation | Sub-workflow precedent anchoring C-7 (sub-workflow contract) industry alignment | <https://www.activepieces.com/pieces/subflows> |
| Argo Workflows — DAG walkthrough | Documentation | DAG/template/suspending composition anchoring C-7 (sub-workflow contract) | <https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/> |
| AWS Step Functions — Best Practices | Documentation | Sub-workflow break-down precedent anchoring C-7 (sub-workflow contract) | <https://docs.aws.amazon.com/step-functions/latest/dg/bp-cwl.html> |
| Dapr — Workflow Patterns | Documentation | Sub-workflow industry-alignment evidence anchoring C-7 (sub-workflow contract) | <https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-patterns/> |
| Apache Airflow 3.0 release blog | Release blog | Major-version break pattern evidence backing the full-engine-at-V1 thesis (Pass D freeze-regret) | <https://airflow.apache.org/blog/airflow-three-point-oh-is-here/> |
| Apache Airflow — Release Notes | Documentation | Cross-version migration-cost precedent backing the full-engine-at-V1 thesis | <https://airflow.apache.org/docs/apache-airflow/stable/release_notes.html> |
| `apache/airflow#9606` (Smart Sensors) | Issue | Smart Sensors deprecate-within-releases precedent backing freeze-regret pattern (deprecate-within-releases) | <https://github.com/apache/airflow/issues/9606> |
| Apache Airflow 2.4.0 release notes | Release notes | Smart Sensors removal record backing freeze-regret pattern | <https://airflow.apache.org/docs/apache-airflow/2.4.0/release_notes.html> |
| Temporal — TypeScript Versioning | Documentation | Workflow-versioning precedent for V1 contract evolution backing the additive-extension strategy | <https://docs.temporal.io/develop/typescript/versioning> |
| Temporal — Worker Versioning | Documentation | Worker-version migration cost backing freeze-regret pattern (replacement expansion) | <https://docs.temporal.io/worker-versioning> |
| Temporal — Worker Versioning Change Log | Changelog | Worker-version forward-compat strategy backing the additive-extension strategy | <https://temporal.io/change-log/worker-versioning-public-preview> |
| `dagger/dagger#4086` (CUE → SDK) | Issue | DSL-replacement break detail backing freeze-regret pattern (replacement expansion); supplements [Dagger CUE→SDK rewrite](https://dagger.io/blog/ending-cue-support/) cited in §Consequences | <https://github.com/dagger/dagger/issues/4086> |
| n8n — BREAKING-CHANGES.md | Code (Sustainable Use) | Workflow-engine break manifest backing freeze-regret evidence (every surveyed system broke later) | <https://github.com/n8n-io/n8n/blob/master/packages/cli/BREAKING-CHANGES.md> |
| n8n — 1.0 release notes | Release notes | n8n 1.0 break detail backing freeze-regret evidence | <https://github.com/n8n-io/n8n/releases/tag/n8n%401.0.0> |
| n8n — 2.0 release notes | Release notes | n8n 2.0 break detail backing freeze-regret evidence | <https://github.com/n8n-io/n8n/releases/tag/n8n%402.0.0> |
| GitHub Actions — HCL → YAML migration (2019) | Engineering blog (post) | Early DSL-replacement break precedent (HCL deprecated for YAML) backing freeze-regret pattern | <https://github.blog/2019-08-08-github-actions-now-supports-ci-cd/> |
| GitHub Actions — `set-output` deprecation | Changelog | Deprecate-then-postpone pattern backing freeze-regret evidence | <https://github.blog/changelog/2022-10-11-github-actions-deprecating-save-state-and-set-output-commands/> |
| GitHub Actions — Node 16 → Node 20 migration | Changelog | Forced-runtime-migration cost backing freeze-regret evidence | <https://github.blog/changelog/2024-03-07-github-actions-all-actions-will-run-on-node20-instead-of-node16-by-default/> |
| GitHub Actions — Artifact v3 deprecation | Changelog | Artifact-API break backing C-9 (artifact immutability) rationale and freeze-regret evidence | <https://github.blog/changelog/2024-04-16-deprecation-notice-v3-of-the-artifact-actions/> |
| GitHub — Immutable releases | Documentation | Immutability rationale supporting C-9 (artifact immutability) | <https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases> |
| CircleCI 1.0 EOL announcement | Engineering blog (post) | DSL-replacement break precedent (1.0 → 2.0) backing freeze-regret evidence | <https://circleci.com/blog/sunsetting-1-0/> |
| OWASP CI/CD Top 10 | Specification (OWASP) | Anchors C-12 (secrets-by-reference) / I1 (argv-only) / I3 (typed substitution) industry-minimum bar | <https://owasp.org/www-project-top-10-ci-cd-security-risks/> |
| NVD CVE-2025-54550 (Airflow secret-masker bypass) | CVE record (NVD) | Anchors I2 (secrets-by-reference invariant) — proves need for cipher-pinned reference indirection | <https://nvd.nist.gov/vuln/detail/CVE-2025-54550> |
| NVD CVE-2025-67895 (Airflow Edge3 RCE) | CVE record (NVD) | Anchors I1 (argv-only execution) — proves need to forbid in-template-string command construction | <https://nvd.nist.gov/vuln/detail/CVE-2025-67895> |
| NVD CVE-2024-47827 (Argo Workflows) | CVE record (NVD) | Anchors I4 (content-addressed external refs) — proves need for content-hash pinning of external workflow refs | <https://nvd.nist.gov/vuln/detail/CVE-2024-47827> |
| NVD CVE-2025-30066 (tj-actions supply-chain compromise) | CVE record (NVD) | Anchors I4 (content-addressed external refs) — supply-chain breach proving content-addressing rationale | <https://nvd.nist.gov/vuln/detail/CVE-2025-30066> |
| CISA — tj-actions advisory | Government advisory (CISA) | Government-attested incident corroborating I4 (content-addressed external refs) for CVE-2025-30066 | <https://www.cisa.gov/news-events/alerts/2025/03/18/supply-chain-compromise-third-party-github-action-cve-2025-30066> |
| GitHub Security Lab — script-injection research | Engineering research (post) | Anchors I3 (typed substitution) — categorizes untrusted-input handling failure modes | <https://securitylab.github.com/research/github-actions-untrusted-input/> |
| GitHub Actions — Security hardening guide | Documentation | I3 industry-minimum bar (default-deny untrusted input) anchoring typed-substitution invariant | <https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions> |
| NVD CVE-2026-33475 (Langflow GitHub Actions command injection) | CVE record (NVD) | Anchors I3 (typed substitution) — untrusted GitHub context values interpolated into `run:` shell commands motivate default-deny substitution | <https://nvd.nist.gov/vuln/detail/CVE-2026-33475> |
| Jenkins Script Security plugin | Code (MIT) | I1 (argv-only execution) sandbox precedent anchoring untrusted-script-eval prohibition | <https://plugins.jenkins.io/script-security/> |
| Temporal — Data Encryption | Documentation | C-12 (secrets-by-reference) — encryption-at-rest precedent for workflow payloads | <https://docs.temporal.io/security#encryption-in-transit> |
| NVD CVE-2025-3248 (Langflow) | CVE record (NVD) | Anchors I1 (argv-only execution) — untrusted-code-eval RCE in agent workflow tooling | <https://nvd.nist.gov/vuln/detail/CVE-2025-3248> |
| NVD CVE-2024-8183 (Prefect) | CVE record (NVD) | Anchors I3 (typed substitution) — input-injection in workflow-engine context | <https://nvd.nist.gov/vuln/detail/CVE-2024-8183> |
| CircleCI January 2023 security incident | Engineering blog (post) | I2 (secrets-by-reference) severity evidence — concrete secrets-incident at CI/CD-engine scope | <https://circleci.com/blog/january-4-2023-security-alert/> |

### Related ADRs

- [ADR-016: Electron Desktop App](./016-electron-desktop-app.md) — chosen desktop runtime; enables Feature 15.
- [ADR-019: Windows V1 Tier and PTY Sidecar](./019-windows-v1-tier-and-pty-sidecar.md) — Windows tier decision; enables V1 shipment across Windows, macOS, Linux.
- [ADR-020: V1 Deployment Model and OSS License](./020-v1-deployment-model-and-oss-license.md) — how V1 is deployed (one open-source codebase whose relay the person deploys for themself, in their own Cloudflare account or on their own server), distinct from what V1 contains.
- [ADR-010: Tokens, Passkeys And The Remote Channel](./010-tokens-passkeys-and-the-remote-channel.md) — PASETO v4 tokens with a device-code sign-in and a DPoP-bound refresh token for the control plane, passkeys only in the web client, the phone apps and the device-code page, and the per-connection `Noise_KK_25519_ChaChaPoly_SHA256` channel between each device and each machine, which Remote Control (feature 24) runs over.

### Related Docs

- [Vision](../vision.md) — signature features, build order, category positioning.
- [V1 Feature Scope](../architecture/v1-feature-scope.md) — the V1 feature list and what is out of scope, against this ADR.
- [Cross-Plan Dependencies](../architecture/cross-plan-dependencies.md) — the forward build order, aligned against this ADR.
- [Spec-014: Multi-Agent Orchestration](../specs/014-multi-agent-orchestration.md) — V1 per this ADR.
- [Spec-015: Workflow Authoring and Execution](../specs/015-workflow-authoring-and-execution.md) — governs V1 Feature 17.
- [Spec-021: Desktop App And Renderer](../specs/021-desktop-app-and-renderer.md) — the desktop surface behind Feature 15.
