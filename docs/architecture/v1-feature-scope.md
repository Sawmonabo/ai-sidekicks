# V1 Feature Scope

## Purpose

This document records the V1 / V1.1 / V2 scope triage for the product. It is governed by [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md). Any change to the triage below requires an ADR update or supersession.

## V1 Features (21)

Every V1 feature has a governing spec; feature #24 (Remote Control) is governed by [Spec-028](../specs/028-remote-control.md). Feature numbers are stable identifiers cited from other documents, so the list skips the numbers of features the product dropped rather than renumbering the survivors. Cross-cutting V1 specs (identity, observability, rate limiting, data retention) are listed separately in §Supporting V1 Specs below.

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
| 14 | Artifact publication (local + cross-node shared) | [Spec-012](../specs/012-artifacts-files-and-attachments.md) — cross-node payload availability is V1 per [ADR-015](../decisions/015-v1-feature-scope-definition.md): eager relay pin of E2EE ciphertext at publish, fetchable while the publishing node is offline. The guarantee holds given an operational relay and against anyone outside the session, **not** against a compromised node of the fetching user, whose forged-ack and attestation-spoof residuals (availability and attribution, not confidentiality) are accepted for V1 and close on the Plan-016 / Plan-002 node-identity primitive. It attaches to a **live** pin — `state = 'pinned'` and `expires_at` still in the future — and ends at the artifact's retention TTL, after which a fetch is a correct `artifact.relay_expired` (410) refusal carrying the re-publish remedy; direct-first fetch stays criterion-gated (C4) |
| 15 | Desktop GUI | [Spec-021: Desktop Shell and Renderer](../specs/021-desktop-shell-and-renderer.md) |
| 16 | Multi-Agent Channels | [Spec-014](../specs/014-multi-agent-channels-and-orchestration.md) |
| 17 | Workflow authoring and execution (full engine) | [Spec-015](../specs/015-workflow-authoring-and-execution.md) |
| 18 | MCP server configuration and governance | [Spec-025](../specs/025-mcp-server-configuration-and-governance.md) + [Plan-025](../plans/025-mcp-server-configuration-and-governance.md). Scope: operator-managed trusted-server store, Cedar-gated per-tool overrides |
| 19 | Session time-travel (run rollback) | [Spec-003](../specs/003-queue-steer-pause-resume.md) (the `rollback` intervention) + the forward `run.rolled_back` event ([Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md)) + the daemon-side turn-snapshot **file-restore** leg ([Spec-008](../specs/008-worktree-lifecycle-and-execution-modes.md) + [Plan-008](../plans/008-worktree-lifecycle-and-execution-modes.md)): the Codex conversation rewind reverts conversation only, so worktree restoration is the daemon's. `thread/rollback` carries its own deprecation in the generated type, and Spec-004 binds the successor `thread/revert {threadId, beforeTurnId}`, which cuts the same thread's own history, so the run keeps its live provider binding and nothing is re-pointed |
| 20 | Session goals | [Spec-014 §Session Goals](../specs/014-multi-agent-channels-and-orchestration.md#session-goals) (goal set/clear RPC) + the `session.goal_*` events in [Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md) |
| 21 | Session callback tools | [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) (registry shape) + [Spec-010](../specs/010-approvals-permissions-and-trust-boundaries.md) (Cedar governance) |
| 22 | Execution postures and sandbox profiles | [Spec-010](../specs/010-approvals-permissions-and-trust-boundaries.md) (`executionPosture` authorization semantics) + [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) (driver legs) |
| 23 | Realtime voice channels (capability-gated) | [Spec-014 §Resolved Questions and V1 Scope Decisions](../specs/014-multi-agent-channels-and-orchestration.md#resolved-questions-and-v1-scope-decisions) (V1-scope-decision reservation) + [Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md) (reserved `realtime_*` family); gated on upstream Codex realtime-flag stabilization |
| 24 | Remote Control — linked devices, device liveness, and full parity from any device | [Spec-028](../specs/028-remote-control.md) |

## V1.1 Features (1, Deferred)

Features with a governing spec already written that defer implementation past V1 on well-named gates.

| # | Feature | Deferral Gate | Governing Spec(s) |
| --- | --- | --- | --- |
| 1 | MLS relay E2EE | Pending audit of an MLS implementation (OpenMLS, mls-rs, or a post-audit TypeScript implementation); V1 ships pairwise X25519 + XChaCha20-Poly1305 per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md). | [Spec-028](../specs/028-remote-control.md) |

(Cross-node shared artifacts are V1 feature-14 scope per [ADR-015](../decisions/015-v1-feature-scope-definition.md); the only deferred leg is the C4 direct-first fetch optimization below.)

Additionally, [ADR-015 §V1.1 Criterion-Gated Commitments](../decisions/015-v1-feature-scope-definition.md#v11-criterion-gated-commitments) carries 4 sub-feature commitments with named promotion criteria: BIND multi-phase channel reuse and `human` phase default-timeout behavior (both tied to Spec-015, Feature 17), the automated GDPR erasure endpoint (criteria in [Plan-020 §Non-Goals](../plans/020-data-retention-and-gdpr.md#non-goals), spec-side record [Spec-020 §V1 Erasure Scope Boundary](../specs/020-data-retention-and-gdpr.md#v1-erasure-scope-boundary)), plus direct-first artifact fetch (C4 — tied to Spec-012, Feature 14; gated on a shipped direct daemon-to-daemon transport).

## V2 (Out of Scope for the V1 Horizon)

Any feature inferable from the product vision but not listed above — including but not limited to first-party native runtime, provider marketplace, mobile clients, enterprise OIDC/SAML flows, SOC 2 compliance artifacts, HSM-backed operator signing, and WAF / IDS / SIEM extensions — is V2 and re-evaluated only after V1 ships.

## Deployment Options (V1)

Per [ADR-020: V1 Deployment Model and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md), V1 ships over two deployment options — the same 21-feature surface runs in either; this is not a feature-count change to the triage above:

- **Free self-hosted (OSS).** Users obtain the product via `git clone`, `npm install`, Homebrew formula, or release-binary download. The daemon defaults to a project-operated free public relay at a published URL so linking a second device is zero-configuration on first run. Users can override via config (`RELAY_URL=…` or `--relay-url=…`) to point at their own self-hosted relay. Community-supported via GitHub Issues and Security Advisories; no SLA.
- **Hosted SaaS.** The project operates the same codebase as a managed service at a separate URL. Users sign up, receive a scoped token, and their daemons point at the hosted control plane. Vendor-supported for paying customers.

Both deployment options ship the 21-feature V1 surface identically. The rate-limiter abstraction in `deployment-topology.md` §Rate Limiting By Deployment uses Cloudflare-native `rate_limit` for hosted and project-operated relay, and `rate-limiter-flexible` with Postgres for the self-hostable relay — both ship in V1. First-run UX presents a one-time three-way choice (free public relay / self-host / sign up for hosted) per Spec-023.

## Platform Support (V1)

Per [ADR-019: Windows V1 Tier and PTY Sidecar Strategy](../decisions/019-windows-v1-tier-and-pty-sidecar.md), V1 ships Windows, macOS, and Linux as GA tiers on equal footing:

| Platform | V1 Tier | PTY Backend |
| --- | --- | --- |
| macOS (arm64, x64) | GA | `NodePtyHost` (in-process `node-pty`) |
| Linux (x64, arm64) | GA | `NodePtyHost` (in-process `node-pty`) |
| Windows 10/11 (x64) | GA | `RustSidecarPtyHost` (child-process Rust sidecar on `portable-pty`) primary; `NodePtyHost` fallback |

Windows GA is contingent on the Rust PTY sidecar strategy in ADR-019, driven by the upstream `node-pty` ConPTY crash cluster (openai/codex#13973, microsoft/node-pty#904/#887/#894/#437/#647). Implementation detail lives in Plan-022. The `PtyHost` interface is declared in `packages/contracts/` so consumers never see the backend choice — see [Component Architecture Local Daemon §PTY Backend Strategy](./component-architecture-local-daemon.md#pty-backend-strategy).

## Supporting V1 Specs (Cross-Cutting)

Cross-cutting V1 specs that multiple V1 features depend on. These are required by V1 but do not correspond to a single row in the table above.

| Spec | Coverage |
| --- | --- |
| [Spec-009](../specs/009-gitflow-pr-and-diff-attribution.md) | Gitflow, PR preparation, and diff attribution |
| [Spec-016](../specs/016-identity-and-user-state.md) | Identity and user state |
| [Spec-017](../specs/017-notifications-and-attention-model.md) | Notifications and attention model |
| [Spec-018](../specs/018-observability-and-failure-recovery.md) | Observability and failure recovery |
| [Spec-019](../specs/019-rate-limiting-policy.md) | Rate limiting policy (both backends ship in V1) |
| [Spec-020](../specs/020-data-retention-and-gdpr.md) | Data retention and GDPR compliance |
| [Spec-022](../specs/022-cross-node-dispatch-and-approval.md) | Cross-node dispatch and approval |
| [Spec-023: First-Run Three-Way-Choice Onboarding](../specs/023-first-run-onboarding.md) | First-run three-way-choice onboarding |

## Spec Coverage Assessment

- **V1 features:** all 21 have a governing spec. Spec-015 (workflow authoring and execution) carries its SA-1…SA-23, SA-25, SA-26, SA-27 and SA-28 items in its own body; SA-24, SA-29, SA-30 and SA-31 live in Plan-015 as implementation detail.
- **V2 features:** intentionally uncovered. V2 scope decisions are made post-V1 and add specs as needed.

## Backlog Coverage Assessment

All V1 features and supporting V1 specs have implementation plans: Plans 001–020 for the existing V1 features (Plan-014 for Multi-Agent Channels and Plan-015 for workflow authoring and execution among them), Plan-021 for the desktop shell, Plan-022 for the PTY sidecar, Plan-023 for first-run onboarding, Plan-024 for Spec-022 cross-node dispatch and approval, Plan-025 for Spec-025 MCP governance, and [Plan-028](../plans/028-remote-control.md) for Spec-028 Remote Control.

## References

- [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md) — the governing decision for this triage.
- [ADR-016: Electron Desktop Shell](../decisions/016-electron-desktop-shell.md) — enables V1 feature 15 (Desktop GUI).
- [ADR-019: Windows V1 Tier and PTY Sidecar Strategy](../decisions/019-windows-v1-tier-and-pty-sidecar.md) — Windows V1 tier decision.
- [ADR-020: V1 Deployment Model and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md) — the two V1 deployment options.
- [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md) — relay encryption choice (pairwise-first V1, MLS V1.1).
- [Vision](../vision.md) — signature features and build order.
- [Backlog](../backlog.md) — open work items against V1 scope.
- [Deployment Topology](./deployment-topology.md) — topologies supporting the two V1 deployment options.
- [Cross-Plan Dependencies](./cross-plan-dependencies.md) — the forward build order aligned against this scope.
