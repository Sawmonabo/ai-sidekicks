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

The product vision (`docs/vision.md`) positions this system as an agentic coding runtime for one user and their agents, with multi-agent sessions, agent-to-agent chat, a desktop-plus-CLI client story, and control of a running session from any linked device as the defining claims.

Two of the vision's claims bear directly on what V1 must contain:

1. **Multi-Agent Channels (Spec-014)** — the vision calls out agent-to-agent chat as a signature feature and positions the product against commodity single-agent CLI runners on exactly this axis; V1 must include it or the category-positioning claim does not match what ships.
2. **Desktop GUI** — the vision build order lists desktop as step 6 of V1 delivery, and the product differentiates against CLI-only offerings (Claude Code, Codex CLI, Aider) in part through a richer desktop surface; V1 must include it for the same reason.

The implementation plans and the cross-cutting specs need one authoritative V1 scope source, which the per-plan `V1 / V1.1` labels and `docs/architecture/cross-plan-dependencies.md` follow. This ADR is that source.

## Problem Statement

What features compose the V1 release of the product, what is deferred to V1.1, and what is out of scope for the V1 horizon entirely?

### Trigger

An earlier scope triage signaled positions that would not survive launch-positioning review, and downstream plans cannot safely cite a scope source until this decision lands.

## Decision

V1 consists of **21 features**. V1.1 defers **1 feature** and carries **4 criterion-gated sub-feature commitments** (see §V1.1 Criterion-Gated Commitments below). Everything else inferable from the product vision is out of scope for the V1 horizon and carries a V2 label for future re-evaluation.

### V1 Features (21)

| # | Feature | Governing Spec(s) |
| --- | --- | --- |
| 1 | Session creation | [Spec-001](../specs/001-session-core.md) |
| 4 | Runtime node attach/detach | [Spec-002](../specs/002-runtime-node-attach.md) |
| 5 | Single-agent runs (Codex, Claude) | [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) |
| 6 | Queue, steer, pause, resume, interrupt | [Spec-003](../specs/003-queue-steer-pause-resume.md) |
| 7 | Approval gates | [Spec-010](../specs/010-approvals-permissions-and-trust-boundaries.md) |
| 8 | Repo attach and workspace binding | [Spec-007](../specs/007-repo-attachment-and-workspace-binding.md) |
| 9 | Worktree-based execution | [Spec-008](../specs/008-worktree-lifecycle-and-execution-modes.md) |
| 10 | Session timeline with replay | [Spec-011](../specs/011-live-timeline-visibility-and-reasoning-surfaces.md), [Spec-013](../specs/013-persistence-recovery-and-replay.md) |
| 11 | Local daemon with CLI | [Spec-006](../specs/006-local-ipc-and-daemon-control.md) |
| 13 | Event audit log | [Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md) |
| 14 | Artifact publication (local + cross-node shared) | [Spec-012](../specs/012-artifacts-files-and-attachments.md): a publish eagerly pins user-encrypted chunked ciphertext to the relay and a fetch is authenticated and `(user, node)`-scoped against per-node wrapped CEKs, so a shared-visible artifact stays fetchable while the publishing node is offline. The guarantee holds under an honest-node threat model and while the pin is **live** — `state = 'pinned'` AND `expires_at` still in the future — ending at the artifact's retention TTL, after which a fetch is a correct `artifact.relay_expired` (410) refusal carrying the re-publish remedy. Two residuals are accepted for V1 because V1 ships no node-identity credential: a forged `ArtifactFetchComplete` ack can advance a sibling's delivery row and drive premature refcount-zero GC, and an artifact-key attestation verifies as signed by any identity key registered to the user with nothing binding the signer to the attested `node_id`. Both are availability- and attribution-class, neither is a confidentiality residual, and both close on the non-forgeable node-identity key in Plan-016 / Plan-002. Normative design in [Spec-012 §Cross-Node Artifact Relay (V1)](../specs/012-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1); direct-first fetch is criterion-gated (C4 below) |
| 15 | Desktop GUI | [Spec-021](../specs/021-desktop-shell-and-renderer.md) |
| 16 | Multi-Agent Channels | [Spec-014](../specs/014-multi-agent-channels-and-orchestration.md) |
| 17 | Workflow authoring and execution (full engine) | [Spec-015](../specs/015-workflow-authoring-and-execution.md): the V1 engine covers the DAG executor, all four phase types (`single-agent`, `automated`, `multi-agent` OWN-only, `human`), all four gate types, parallel execution with `ParallelJoinPolicy`, resource pools, the visual builder and its node catalog, the entry node’s trigger kinds, and the `workflow.*` event taxonomy across its five categories. The full contract is in Spec-015 and [Plan-015](../plans/015-workflow-authoring-and-execution.md). |
| 18 | MCP server configuration and governance | [Spec-025](../specs/025-mcp-server-configuration-and-governance.md) + [Plan-025](../plans/025-mcp-server-configuration-and-governance.md): server-config CRUD, an operator-managed trusted-server store with Cedar-gated per-tool overrides, zero-billed-turn status and health probing, and server OAuth |
| 19 | Session time-travel (run rollback) | [Spec-003](../specs/003-queue-steer-pause-resume.md) (`rollback` intervention on the generic dispatch, implemented by [Plan-003](../plans/003-queue-steer-pause-resume.md)), [ADR-017](./017-shared-event-sourcing-scope.md) (a forward `run.rolled_back` event — the log never truncates), [Spec-008](../specs/008-worktree-lifecycle-and-execution-modes.md) + [Plan-008](../plans/008-worktree-lifecycle-and-execution-modes.md) (the daemon-side turn-snapshot **file-restore** leg). The provider rewind reverts the conversation only and leaves working-tree restoration to the daemon, per the [provider-wire receipt](../reference/provider-wire/codex.md), so a rollback that dispatched without the turn snapshot would emit `run.rolled_back` while leaving the worktree at the post-rollback state. [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) binds the Codex rollback grade onto `thread/revert {threadId, beforeTurnId}`, which cuts the same thread's own history so the run keeps its live provider binding; `thread/rollback` carries its own deprecation in the generated type and no driver registers it. |
| 20 | Session goals | [Spec-014](../specs/014-multi-agent-channels-and-orchestration.md) (a per-session structured goal with set and clear RPCs), [Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md) (the `session.goal_*` events) |
| 21 | Session callback tools | [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) (the daemon-registered tool shape), [Spec-010](../specs/010-approvals-permissions-and-trust-boundaries.md) (Cedar-governed identically to provider tools) |
| 22 | Execution postures and sandbox profiles | [Spec-010](../specs/010-approvals-permissions-and-trust-boundaries.md) (`executionPosture` as an authorization input), [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) (the posture shape) |
| 23 | Realtime voice channels (capability-gated) | [Spec-014](../specs/014-multi-agent-channels-and-orchestration.md) (the V1 scope reservation), [Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md) (the reserved `realtime_*` event family); gated on upstream Codex realtime-flag stabilization — a named external gate, with no Claude-leg emulation claimed |
| 24 | Remote Control | [Spec-028](../specs/028-remote-control.md) + [Plan-028](../plans/028-remote-control.md) — a session is driven from any of the user's linked devices with full parity, while the run stays on the runtime node that owns the repo; [Spec-029](../specs/029-ios-remote-client.md) carries the iOS client surface |

### V1.1 Features (1, deferred)

| # | Feature | Deferral Rationale |
| --- | --- | --- |
| 1 | MLS relay E2EE | Pending audit of an MLS implementation (OpenMLS, mls-rs, or a post-audit TypeScript implementation); V1 ships pairwise X25519 + XChaCha20-Poly1305 per [ADR-010](./010-paseto-webauthn-mls-auth.md). |

(Cross-node shared artifacts are part of feature 14; the only deferred leg is the C4 direct-first fetch optimization below.)

### V1.1 Criterion-Gated Commitments

Sub-features explicitly committed for V1.1 under named criteria (V1→V1.1 deferrals require concrete promotion gates in the ADR, not vague "maybe later"). Criteria below are stated inline; they are grounded in 2025–2026 durable-execution convergence evidence (primary sources consolidated in §Research Conducted).

**C1 — BIND multi-phase channel reuse (committed V1.1):**

Add `ownership: 'BIND'` to `multi-agent` phase contract in V1.1, contingent on **all three** criteria:

- (a) **Production signal:** ≥3 production workflows reporting OWN + transcript-inheritance insufficient for a documented user goal, AND
- (b) **Concrete failure case:** at least one documented case where the transcript-as-context pattern degrades UX measurably (e.g., agent context loss detectable in outcomes), AND
- (c) **Lifecycle contract:** a BIND lifecycle contract addressing the 5 ambiguities — phase-A-retry semantics, phase-A-abandonment handling, gate-scoping-lattice resolution, channel-agent-snapshot timing, termination-authority resolution.

If (a)–(c) are satisfied, BIND ships as an additive extension of the `multi-agent` phase type (SDK ergonomics: new `ownership: 'BIND'` discriminant). If any of (a)–(c) is not satisfied within V1.1's scoping window, BIND remains deferred under the same criteria.

**Rationale for criterion-gated deferral (not inclusion at V1):** 2025–2026 durable-execution composition convergence is state-passing, not handle-binding. Temporal Child Workflows use explicit Signals over shared state ([Temporal Child Workflows](https://docs.temporal.io/child-workflows), accessed 2026-04-22); Airflow's closest BIND analogue (SubDAGs) was deprecated in favor of TaskGroups after multi-year lifecycle-bug and worker-slot-starvation history ([Airflow SubDAG deprecation tracking issue #12292](https://github.com/apache/airflow/issues/12292)). BIND at V1 would import a 5-invariant state-machine expansion and confused-deputy vulnerability class for a feature lacking production demand signal. OWN-only → V1.1 BIND is additive (no breaking change); OWN + BIND at V1 → V1.1 revision would be breaking.

**C2 — `human` phase default-timeout behavior (committed V1.x):**

Reconsider the `HumanPhaseConfig` default-timeout policy once a notification-routing primitive exists in the product. Single promotion criterion:

- (a) **Notification-routing V1.x feature shipped:** daemon can route a "human phase escalated" event to an actual human recipient (not telemetry-only).

Until (a) is met, V1's required typed `timeout: "none" | Duration` opt-in (per Spec-015 SA-10) stands: authors must type either `"none"` or an explicit duration. A 7-day soft-cap + escalate default was considered and rejected for V1 because without notification routing the escalate path fires a `workflow.human_phase_escalated` event to telemetry but does not page a human — a "guardrail that looks like protection but isn't" (silent-failure class, directly violating C-12 Loud-errors invariant). The V1 stance matches modern durable-execution convention: Temporal Workflow Execution Timeout defaults to ∞ and authors opt in explicitly ([Temporal — Managing very long-running workflows](https://temporal.io/blog/very-long-running-workflows), accessed 2026-04-22); Argo suspend primitives are indefinite-by-default ([Argo Workflows — Suspending walk-through](https://argo-workflows.readthedocs.io/en/latest/walk-through/suspending/)).

**C3 — Automated GDPR erasure endpoint (committed V1.1):**

Promote the V1 `gdpr.*` stubs (schema + write path ship in V1; the three daemon JSON-RPC methods refuse with `-32603` + `data.type: "gdpr.endpoint_not_v1"` per Plan-020 D-020-3) to automated deletion/export/purge handlers in V1.1, contingent on **all three** criteria (stated in [Plan-020 §Non-Goals](../plans/020-data-retention-and-gdpr.md#non-goals); paired spec-side record: [Spec-020 §V1 Erasure Scope Boundary](../specs/020-data-retention-and-gdpr.md#v1-erasure-scope-boundary), which enumerates the promotion criteria via [Plan-020 §Non-Goals](../plans/020-data-retention-and-gdpr.md#non-goals)):

- (i) **Fan-out closure complete:** every CP-020-6 fan-out target's owner plan has shipped its table + Path-2 reciprocal — the automated shred spans the full `REFERENCES users(id)` closure (fifteen rows over Plan-001, Plan-002, Plan-012, Plan-016 and Plan-017, plus forward-declared rows in Plan-022 and Plan-024), several of which are unbuilt until their owner plans land, AND
- (ii) **FK-safety migration landed:** the D-020-7 `ON DELETE SET NULL` forward ALTER relaxing the anonymize-class FKs has landed, AND
- (iii) **Equivalence proof:** cross-store fan-out equivalence tests prove no closure row is missed.

**Rationale for criterion-gated deferral (not inclusion at V1):** (a) **cross-plan completeness** — with the later owner tables unbuilt, a V1 automated endpoint would necessarily be partial and report success on an incomplete fan-out (the silent-failure class the C-12 Loud-errors invariant exists to block); (b) **protection-over-automation** — V1 erasure is satisfiable by hand (crypto-shred = `DELETE FROM user_keys`; Postgres severance = the D-020-7 migration), so a data-subject request is honorable in V1 via the [GDPR Manual Erasure Runbook](../operations/gdpr-manual-erasure-runbook.md) without risking a half-built automated path. If (i)–(iii) are satisfied, the automated handlers ship in V1.1, replacing the stub refusals additively; until then the deferral stands as scoped in [Plan-020 §Non-Goals](../plans/020-data-retention-and-gdpr.md#non-goals).

**C4 — Direct-first artifact fetch (committed V1.x):**

Add the direct device-to-device fetch leg to the cross-node artifact relay (feature 14): fetch the payload from the publishing daemon when it is reachable, with the eagerly pinned relay copy as the guaranteed fallback. Single promotion criterion:

- (a) **Direct daemon transport shipped:** a daemon-to-daemon direct data channel (reachability signaling plus NAT traversal or LAN peer discovery) exists as a shipped, spec-governed transport primitive.

**Rationale for criterion-gated deferral (not inclusion at V1):** the eager relay pin already delivers the user-facing guarantee — a shared-visible artifact is fetchable while its publisher is offline (scoped to an honest-node threat model and bounded to a live pin ending at the artifact's retention TTL, per feature 14 above; the direct leg is not a remedy for either accepted residual, since both are reachable from inside the user's own trust domain) — so the direct leg buys only publisher-online latency and relay-bandwidth savings. V1 ships no direct daemon-to-daemon data path (cross-node traffic is relay-mediated: [Spec-022](../specs/022-cross-node-dispatch-and-approval.md) delivers dispatch via the relay's pairwise-encrypted payload channel, and [deployment-topology.md](../architecture/deployment-topology.md) defines remote access as `Relay-Assisted Remote Access`), and building NAT traversal solely for an optimization would couple feature 14 to an unshipped transport subsystem. The [Spec-012 §Cross-Node Artifact Relay (V1)](../specs/012-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1) wire format ships V1-ready for the direct leg (`replicationStatus` pin states, digest addressing, per-chunk signed manifest), so C4 lands additively with no wire or schema break — the magic-wormhole/Syncthing precedent, where direct and relay transports coexist behind one addressing scheme.

### V2 (Out of Scope for the V1 Horizon)

Any feature inferable from the vision document or signature-feature framing but not listed above — including but not limited to first-party native runtime, provider marketplace, mobile clients, enterprise OIDC/SAML flows, SOC 2 compliance artifacts — is V2 and re-evaluated only after V1 ships.

### Thesis — Why This Option

The product's category positioning rests on three claims: multi-agent sessions, a desktop-plus-CLI experience, and control of a live session from any linked device. Shipping V1 without Multi-Agent Channels or Desktop GUI launches into a crowded market (Claude Code, Codex CLI, Aider, Cursor, Windsurf) without the features that justify the product's existence. Landing V1 at the full surface above rather than a narrower alternative pays the implementation cost to preserve the differentiators.

Treating Multi-Agent Channels as a V1 quality gate forces the team to harden Spec-014 — turn policy defaults, budget policy defaults, stop conditions, partition behavior — rather than leaving it as "spec exists, implementation deferred." That quality work matters the moment any two agents talk to each other in a session, which happens on day one of V1.

### Antithesis — The Strongest Case Against

A staff engineer looking at a pre-code project with a V1 target this broad has legitimate concern: a broad V1 is the single most common cause of greenfield project slip. Every V1 feature is a concurrent dependency in the critical path. Multi-Agent Channels in particular carries orchestration, budget, and partition-behavior complexity that single-agent runs do not. Desktop GUI carries Electron packaging, auto-update, code-signing, and cross-platform QA burden. A narrower V1 (Option B below) launches faster, validates the agent-runtime core under real load, and upgrades to multi-agent in a V1.1 release six months later with full production data to drive the quality bar. That is how most successful platforms have shipped.

### Synthesis — Why It Still Holds

The antithesis assumes V1 launch speed is the dominant cost. For this product, launch positioning is the dominant cost. A CLI-only single-agent V1 does not survive the first launch-day comparison thread — the product would be reviewed as "another CLI agent runner, but less mature than Aider or Claude Code." The scope-size risk is real but bounded by two factors: (1) AI implementation costs (Claude Opus 4.7 executing the plans) collapse engineering-week counts relative to human-labor estimates; (2) build-order discipline via [`docs/architecture/cross-plan-dependencies.md`](../architecture/cross-plan-dependencies.md) keeps work sequenced rather than parallel-fire. The quality risk on Multi-Agent Channels is the more serious concern; the mitigation is a V1-readiness review of Spec-014 before Plan-014 is built.

## Alternatives Considered

### Option A: The chosen V1 set

- **What:** Ship the full feature list above as the V1 target.
- **Steel man:** Aligns shipped scope with vision positioning; resolves the two scope inconsistencies named in §Context; establishes one authoritative source the plans and the cross-cutting specs cite; sets the Multi-Agent Channels quality bar at V1 where it belongs.
- **Weaknesses:** Larger V1 surface = more implementation work before first ship; Multi-Agent Channels quality bar adds hardening work that would otherwise defer; Desktop GUI adds a second client track in the critical path rather than strictly after CLI proves the contract.

### Option B: The smaller set (rejected)

- **What:** Ship a narrower V1 with Desktop GUI and Multi-Agent Channels pushed to V1.1.
- **Steel man:** Faster time to first-ship. CLI-first validates the typed client SDK and daemon contract before desktop-specific UX adds complexity (which matches the vision build-order recommendation for CLI as step 3 and desktop as step 6). Single-agent V1 validates the run state machine, driver contract, and approval gates under real traffic before multi-agent adds turn policy and budget enforcement. Solo / small-team reality check: even a narrower surface is a stretch for one engineering resource, even with AI implementation.
- **Why rejected:** A CLI-only single-agent V1 launches into direct comparison with Claude Code, Codex CLI, Aider, Cursor, Windsurf, and the broader coding-agent field. Those products are mature on the CLI+single-agent axis. The category-defining claim for this product is explicitly _multi-agent, steerable, and reachable from any of the user's devices_ — vision Thesis and Product Goal both state this in the first ten lines. Shipping V1 without the category-defining features launches the product as a weaker commodity offering on the axis where it is strongest. The time-to-first-ship optimization is chasing the wrong metric for a greenfield product whose value is its positioning.

### Option C: Tiered M1–M4 milestone track (Rejected)

- **What:** Partition the V1 features into four sequential milestone releases, each a customer-facing release.
- **Steel man:** Incremental customer feedback at each milestone; reduced risk of a big-bang launch; explicit cut points for scope adjustment between milestones; operational release-pipeline discipline earned incrementally rather than all at once; easier to message "we're shipping now, more next month" than "we're still building, launch TBD."
- **Why rejected:** Adds PM overhead and customer-communication surface without reducing engineering risk for a greenfield pre-code project. Each milestone boundary requires release-pipeline investment (signing, auto-update, changelog cadence, deprecation windows) earlier than a single-target V1 requires it. The backlog already enforces build-order structure via `docs/architecture/cross-plan-dependencies.md`; that granularity is sufficient for engineering sequencing without making milestone boundaries customer-facing. Making them customer-facing is the cost; the benefit (incremental feedback) is available to any greenfield team via private beta without public M1/M2/M3 release mechanics. The milestone track also pushes the category-positioning launch to M2 or later, which re-raises the Option B problem.

## Reversibility Assessment

- **Reversal cost:** Low to Medium while pre-code. Moving a feature between V1 / V1.1 / V2 requires: changing this ADR, rewriting `docs/architecture/v1-feature-scope.md`, updating `docs/architecture/cross-plan-dependencies.md`, updating the affected plan file's scope label. No code-migration cost before first ship; moderate doc-churn cost. Once V1 ships, promoting a V1.1 feature to V1 requires re-versioning the release and is higher cost.
- **Blast radius:** `docs/architecture/v1-feature-scope.md`, `docs/architecture/cross-plan-dependencies.md`, every plan file, any ADR or spec referencing a V1 label.
- **Migration path:** Replace this ADR with a new one, rerun the `V1\.1|V2|deferred` sweep against `docs/plans/*.md` to catch label drift, and realign `cross-plan-dependencies.md`.
- **Point of no return:** First V1 ship to users. Until then, reversal is free. After, feature-set expectations carry.

## Consequences

### Positive

- Single authoritative scope source for the plans and the cross-cutting specs.
- Shipped scope matches vision positioning; the two scope inconsistencies named in §Context resolve against this ADR.
- Multi-Agent Channels quality bar lands at V1 where it meets the category-positioning claim.
- Desktop GUI lands at V1 so launch positioning includes both client tracks vision names.

### Negative (accepted trade-offs)

- Larger V1 surface means more implementation work before first ship.
- The Multi-Agent Channels V1-readiness review becomes a V1 gate rather than a V1.1 nice-to-have; hardening cost is real.
- Desktop GUI adds Electron packaging, auto-update, code-signing, and cross-platform QA work to V1; carried via [ADR-016](./016-electron-desktop-shell.md) (desktop shell) and [Plan-021](../plans/021-desktop-shell-and-renderer.md) (desktop implementation).
- Full workflow engine surface per Spec-015 (V1 feature 17) is V1 build cost — covers DAG executor, four phase types, four gate types, parallel execution, resource pools, the `workflow.*` event taxonomy across its five categories, the SQLite persistence schema [Spec-015 §State And Data Implications](../specs/015-workflow-authoring-and-execution.md#state-and-data-implications) fixes at thirteen tables, property/fuzz/load/integration/security test battery. Justified by research showing post-V1 retrofit of phase-type additions, parallel execution, and durable human-phase resumption is architecturally heavier than V1-native implementation: every surveyed system (Airflow, Dagger, GitHub Actions, n8n, Temporal, Argo, CircleCI) paid breaking-change cost retrofitting what V1-native would have covered additively. Three freeze-regret patterns: additive enum expansion (safe); replacement expansion (breaking, e.g., [Dagger CUE→SDK rewrite](https://dagger.io/blog/ending-cue-support/)); execution-model commitment (deprecate-within-releases). Primary sources consolidated in §Research Conducted.

### Unknowns

- V1 delivery timeline under the chosen scope — no fixed date commitment; tier discipline drives sequencing.
- Whether the Multi-Agent Channels V1 quality bar can be met without in-production traffic; the Spec-014 V1-readiness review is the primary gate.

## References

### Research Conducted

**Cross-node artifact relay sources** — the seven-axis survey behind feature 14's relay design; the full set (~25 primaries) is in [Spec-012 §References](../specs/012-artifacts-files-and-attachments.md#references):

- [Wire Security Whitepaper](https://wire-docs.wire.com/download/Wire+Security+Whitepaper.pdf) + [AWS KMS data keys](https://docs.aws.amazon.com/kms/latest/developerguide/data-keys.html) — one-ciphertext-upload with per-recipient key fan-out; the envelope-encryption model the relay adopts
- [Matrix MSC3916 — authentication for media](https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/3916-authentication-for-media.md) + [Synapse media repository](https://matrix-org.github.io/synapse/latest/media_repository.html) — the capability-URL → authenticated-media retrofit, and the lazy remote-media-cache availability gap that rules out cache-on-miss pinning
- ["Missing Salamanders"](https://lotte.chir.rs/2024/08/17/Missing-Salamanders-Matrix-Media-can-be-decrypted-to-multiple-valid-plaintexts-using-different-keys/), [Albertini et al. (USENIX Security 2022)](https://www.usenix.org/conference/usenixsecurity22/presentation/albertini), and [Len, Grubbs, Ristenpart (USENIX Security 2021)](https://www.usenix.org/conference/usenixsecurity21/presentation/len) — the key non-commitment attack class; grounds the signed `cekCommitment` requirement (AEAD alone is not key-committing)
- [tus resumable-upload protocol 1.0](https://tus.io/protocols/resumable-upload/1-0-x) + [S3 multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) — chunked resumable transfer, received-set/offset discovery, incomplete-upload reaping
- [RFC 9449 DPoP](https://datatracker.ietf.org/doc/html/rfc9449) + [W3C TAG capability-URLs finding](https://www.w3.org/2001/tag/doc/capability-urls/) + [Firefox Send shutdown notice (Mozilla Blog, 2020-09-17)](https://blog.mozilla.org/en/uncategorized/update-on-firefox-send-and-firefox-notes/) — sender-constrained authenticated fetch; the first-party abuse post-mortem ("ship malware and conduct spear phishing attacks") behind prohibiting capability URLs
- [NIST SP 800-88 Rev. 2](https://csrc.nist.gov/pubs/sp/800/88/r2/final) + [CJEU _EDPS v SRB_ (4 Sept 2025)](https://curia.europa.eu/site/upload/docs/application/pdf/2025-09/cp250107en.pdf) — Cryptographic Erase and the recipient-relative personal-data reading framing the relay-ciphertext GDPR posture
- [Bitwarden Send lifespan](https://bitwarden.com/help/send-lifespan/) + [IPFS garbage collection](https://blog.logrocket.com/guide-ipfs-garbage-collection/) + [Synapse issue #3339](https://github.com/matrix-org/synapse/issues/3339) — TTL tiers, watermark GC, and the build-your-own-quota gap

**MCP governance and realtime-gate sources:**

- [MCP specification 2025-11-25 — Tools page](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) — the execution-safety surface grounding feature #18's governance gates: `execution.taskSupport` on tool definitions, and the Tools-page trust warning — "clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers" (verified verbatim 2026-07-02). The MUST binds trust classification, not behavior derivation — the schema doc-comments phrase the same rule as hints ("should never make tool use decisions based on ToolAnnotations received from untrusted servers") — so the gates bind on the operator-managed trusted-server store, never on annotation self-claims
- [MCP blog — tool annotations (2026-03-16)](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/) — annotation-trust guidance consumed by the same gates
- [MCP Authorization (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) — the OAuth surface feature #18's `server OAuth` scope targets: OAuth 2.1 (IETF draft) with Authorization Server Metadata, Dynamic Client Registration, and Protected Resource Metadata (verified live 2026-07-02); Spec-025 pins its flow against this revision
- Feature #23's external gate is a runtime filter, not a schema omission: the eight `thread/realtime/*` server notifications are present in the Codex app-server's **default** generated schema, and generating the schema cannot detect the gate at all, because the default and `--experimental` `ServerNotification` unions are measurably **identical** at both the supported floor and the pin. What withholds them is `should_skip_notification_for_connection`, a runtime filter dropping every experimental notification — silently, with no error — for any connection that did not set `initialize.capabilities.experimentalApi`. The family stays externally gated for V1 and its trust grade stays Provisional; Spec-014 / Spec-005 authors MUST re-verify by **probing that runtime gate** against the then-installed binary before reserving or activating the surface, never by re-reading the generated union, per the receipt's §Version pin — receipts in [`docs/reference/provider-wire/codex.md`](../reference/provider-wire/codex.md), regenerated from the pinned binary via `codex app-server generate-json-schema`, upstream [openai/codex](https://github.com/openai/codex)

Feature 17 (workflow authoring and execution) is grounded in primary-source evidence across seven research dimensions: parallel execution (Pass A — DAG executor, resource pools, parallel join policy), multi-agent channel contract (Pass B — ownership, sub-workflow lifecycle, BIND-criterion evidence backing §V1.1 Criterion-Gated Commitments), event taxonomy (CloudEvents / OpenTelemetry / Temporal — anchors SA-18/19/20), persistence patterns (Pass G — SQLite WAL, Crosby & Wallach hash-chain, Trillian, AuditableLLM), test infrastructure (fast-check, Jazzer.js — anchors SA-29), human-phase upload safety (OWASP — anchors I6), post-V1 freeze-regret evidence (Pass D — 7-system V1-shipping-pattern survey backing the full-engine-at-V1 thesis), and security invariants I1–I7 (Pass E — CVE corpus per invariant). Cross-Pass duplications (Crosby & Wallach, OWASP File Upload, CloudEvents, OpenTelemetry semconv, Temporal events) are cited once with the broadest-applicable Pass framing. Additional Pass C (human-phase UX), Pass F (event-taxonomy detail), Pass G (persistence-pattern detail), and Pass H (testing-strategy detail) primaries are in [Spec-015 §References](../specs/015-workflow-authoring-and-execution.md#references) and [Plan-015 §References](../plans/015-workflow-authoring-and-execution.md#references).

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| CloudEvents v1.0.2 specification | Specification (CNCF) | Envelope additive-bump rules anchor SA-18 (workflow event envelope additive MINOR bump); subject field carries workflow-run scoping | <https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md> |
| OpenTelemetry Semantic Conventions for Events | Specification (CNCF) | Event-name hierarchical convention anchors SA-19 (`workflow.<resource>.<lifecycle>` naming) | <https://github.com/open-telemetry/semantic-conventions/blob/main/docs/general/events.md> |
| Temporal Events Reference | Documentation | Reserved-event taxonomy (`WorkflowExecutionStarted`, `ActivityTaskScheduled`, etc.) anchors SA-20 reserved-event list and projection-rebuild contract | <https://docs.temporal.io/references/events> |
| SQLite Write-Ahead Logging | Specification (SQLite) | WAL-mode durability and `synchronous=FULL` rationale for the workflow persistence schema (Pass G) | <https://www.sqlite.org/wal.html> |
| Crosby & Wallach — "Efficient Data Structures for Tamper-Evident Logging" (USENIX Security 2009) | Academic paper | Per-run hash-chain construction underwriting C-13 (event-log integrity) and I7 (append-only event log invariant) | <https://www.usenix.org/legacy/event/sec09/tech/full_papers/crosby.pdf> |
| AuditableLLM — "Auditable AI: Tamper-Evident Logging of LLM Interactions" (MDPI Electronics 14 (10): 2059, 2025) | Academic paper | LLM-specific audit-log precedent corroborating C-13 hash-chain choice for agent-execution event streams | <https://www.mdpi.com/2079-9292/14/10/2059> |
| Google Trillian | Code (Apache-2.0) | Operational transparency-log precedent for hash-chained append-only logging at scale; reference implementation underpinning C-13 | <https://github.com/google/trillian> |
| fast-check (model-based property testing) | Code (MIT) | Property-test framework anchoring SA-29 test-category battery (property/fuzz/load/integration/security-regression) | <https://github.com/dubzzz/fast-check> |
| Jazzer.js (coverage-guided fuzzing for Node.js) | Code (Apache-2.0) | Fuzz-test framework anchoring SA-29 fuzz-target category for parameter-substitution and event-envelope parsing | <https://github.com/CodeIntelligenceTesting/jazzer.js> |
| OWASP File Upload Cheat Sheet | Specification (OWASP) | Human-upload validation minimums anchoring I6 (human-phase upload OWASP minimums) and SA-26 form-state lifecycle | <https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html> |
| Apache Airflow `dag.py` source | Code (Apache-2.0) | Kahn's-algorithm topological-sort DAG executor precedent anchoring C-3 (DAG executor) | <https://github.com/apache/airflow/blob/main/airflow-core/src/airflow/models/dag.py> |
| Apache Airflow Pools | Documentation | Slot-based concurrency pools anchoring SA-3 (resource pools) | <https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html> |
| Astronomer — Managing Dependencies (Airflow trigger rules) | Documentation | Trigger-rules taxonomy (`all_success`, `one_failed`, etc.) anchoring C-3 (DAG executor) trigger semantics | <https://www.astronomer.io/docs/learn/managing-dependencies> |
| Temporal Go SDK (workflow primitives) | Documentation | Durable-execution primitive precedent anchoring C-3 (DAG executor) and C-7 (sub-workflow contract) | <https://docs.temporal.io/develop/go> |
| Argo Workflows — Parallelism | Documentation | Workflow-level parallelism cap anchoring SA-3 (resource pools) parallelism budget | <https://argo-workflows.readthedocs.io/en/latest/parallelism/> |
| Dagster Run Concurrency | Documentation | Multi-tier resource-pool precedent (run-tags + concurrency keys) anchoring SA-3 (resource pools) | <https://docs.dagster.io/guides/operate/managing-concurrency> |
| AWS Step Functions — Error Handling | Documentation | `Catch` / `Retry` semantics anchoring SA-4 (`ParallelJoinPolicy` `fail-fast` precedent) | <https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html> |
| Temporal — ParentClosePolicy | Documentation | Child-workflow lifecycle on parent close anchors SA-6 (multi-agent ownership: OWN-only V1) and BIND lifecycle deltas | <https://docs.temporal.io/develop/typescript/child-workflows#parent-close-policy> |
| Apache Airflow 2.0 release blog | Release blog | SubDAG → TaskGroup migration cost evidence backing BIND-criterion (b) (concrete failure case) and §V1.1 Criterion-Gated Commitments | <https://airflow.apache.org/blog/airflow-two-point-oh-is-here/> |
| `apache/airflow#1350` (SubDAG removal) | Issue | SubDAG deprecation primary record anchoring BIND-criterion (b) failure case | <https://github.com/apache/airflow/issues/1350> |
| Apache Airflow — Task Groups | Documentation | SubDAG migration cost evidence anchoring BIND-criterion freeze-regret rationale | <https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html#taskgroups> |
| Apache Airflow — SubDagOperator API | Documentation | Concrete BIND failure mode: SubDagOperator can occupy pool/concurrency slots and must release slots periodically to avoid potential deadlock | <https://airflow.apache.org/docs/apache-airflow/2.5.1/_api/airflow/operators/subdag/index.html> |
| n8n — `executeWorkflow` node | Documentation | Sub-workflow precedent anchoring C-7 (sub-workflow contract) industry alignment | <https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow/> |
| Activepieces Sub Flows | Documentation | Sub-workflow precedent anchoring C-7 (sub-workflow contract) industry alignment | <https://www.activepieces.com/pieces/subflows> |
| Argo Workflows — DAG walkthrough | Documentation | DAG/template/suspending composition anchoring C-7 (sub-workflow contract) | <https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/> |
| `argoproj/argo-workflows#12425` | Issue | Sub-workflow lifecycle ambiguity precedent anchoring BIND lifecycle-contract requirement | <https://github.com/argoproj/argo-workflows/issues/12425> |
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
| NVD CVE-2024-53862 (Argo Workflows) | CVE record (NVD) | Anchors I6 (human-upload OWASP minimums) — secondary corroboration to CVE-2025-66626 | <https://nvd.nist.gov/vuln/detail/CVE-2024-53862> |
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

- [ADR-016: Electron Desktop Shell](./016-electron-desktop-shell.md) — chosen desktop runtime; enables Feature 15.
- [ADR-019: Windows V1 Tier and PTY Sidecar](./019-windows-v1-tier-and-pty-sidecar.md) — Windows tier decision; enables V1 shipment across Windows, macOS, Linux.
- [ADR-020: V1 Deployment Model and OSS License](./020-v1-deployment-model-and-oss-license.md) — how V1 is shipped (OSS self-host + hosted SaaS), distinct from what V1 contains.
- [ADR-010: PASETO + WebAuthn + MLS Auth](./010-paseto-webauthn-mls-auth.md) — relay encryption choice that places MLS at V1.1 rather than V1.

### Related Docs

- [Vision](../vision.md) — signature features, build order, category positioning.
- [V1 Feature Scope](../architecture/v1-feature-scope.md) — the V1 / V1.1 / V2 triage against this ADR.
- [Cross-Plan Dependencies](../architecture/cross-plan-dependencies.md) — the forward build order, aligned against this ADR.
- [Spec-014: Multi-Agent Channels and Orchestration](../specs/014-multi-agent-channels-and-orchestration.md) — V1 per this ADR.
- [Spec-015: Workflow Authoring and Execution](../specs/015-workflow-authoring-and-execution.md) — governs V1 Feature 17.
- [Spec-021: Desktop Shell and Renderer](../specs/021-desktop-shell-and-renderer.md) — the desktop surface behind Feature 15.
