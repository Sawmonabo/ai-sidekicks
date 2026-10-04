# V1 Feature Scope

## Purpose

This document records the V1 feature scope for the product: the features V1 ships and what is out of scope. [ADR-014: V1 Feature Scope Definition](../decisions/014-v1-feature-scope-definition.md) records the reasoning.

## V1 Features (21)

Every V1 feature has a governing spec; feature #21 (Remote Control) is governed by [Spec-027](../specs/027-remote-control.md). Feature numbers run with no gaps; removing a feature renumbers the ones after it and every reference to them. Cross-cutting V1 specs (identity, observability, rate limiting, data retention) are listed separately in §Supporting V1 Specs below.

| # | Feature | Governing Spec(s) |
| --- | --- | --- |
| 1 | Session creation | [Spec-001](../specs/001-session-core.md) |
| 2 | Machine registration | [Spec-002](../specs/002-machine-registration.md) — the machine that runs your sessions, which the backend calls a runtime node, registers once with the control plane, keyed by the machine and its owner, and is reached through the relay; it is reachable while its relay connection is up, and a session never moves to another machine |
| 3 | Single-agent runs (Codex, Claude) | [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) |
| 4 | Queue, steer, pause, resume, interrupt | [Spec-003](../specs/003-queue-steer-pause-resume.md) |
| 5 | Approval gates | [Spec-010](../specs/010-approvals-permissions-and-trust-boundaries.md) |
| 6 | Repo attach and workspace binding | [Spec-007](../specs/007-repo-attachment-and-workspace-binding.md) |
| 7 | Worktree-based execution | [Spec-008](../specs/008-worktree-lifecycle-and-execution-modes.md) |
| 8 | Session transcript with replay | [Spec-011](../specs/011-transcript-and-reasoning.md), [Spec-013](../specs/013-persistence-recovery-and-replay.md) |
| 9 | Local daemon with CLI | [Spec-006](../specs/006-local-ipc-and-daemon-control.md) |
| 10 | Event audit log | [Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md) |
| 11 | Artifact publication | [Spec-012](../specs/012-artifacts-files-and-attachments.md) — a session's artifacts stay on the machine that runs the session, which lists them on every linked device; a device reads them through Remote Control's method proxy, and the relay keeps no copy |
| 12 | Desktop GUI | [Spec-021: Desktop App And Renderer](../specs/021-desktop-app-and-renderer.md) |
| 13 | Multi-agent orchestration | [Spec-014](../specs/014-multi-agent-orchestration.md) |
| 14 | Workflow authoring and execution (full engine) | [Spec-015](../specs/015-workflow-authoring-and-execution.md) |
| 15 | MCP server configuration and governance | [Spec-024](../specs/024-mcp-server-configuration-and-governance.md) + [Plan-022](../plans/022-mcp-server-configuration-and-governance.md). Scope: server configuration at every scope, per-tool approval overrides set on Settings › MCP servers |
| 16 | Undo to an earlier message | [Spec-003](../specs/003-queue-steer-pause-resume.md) (the undo: the conversation and the files, the conversation alone, or the files alone, one request with one reported result) + the daemon's own file checkpoint store ([Spec-013 §Required Behavior](../specs/013-persistence-recovery-and-replay.md#required-behavior)) + the forward `session.restore_finished` event, with `run.rolled_back` for the conversation cut ([Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md)). The conversation goes back through the provider's own cut, Claude Code's `rewind_conversation` and Codex's `thread/revert {threadId, beforeTurnId}`, neither of which touches a file; the files go back through the daemon's checkpoints, never through the git snapshot. A point before Claude Code's last compaction is reached through the provider's own copy of the conversation, resumed in place, so the session keeps its identity |
| 17 | Session goals | [Spec-014 §Session Goals](../specs/014-multi-agent-orchestration.md#session-goals) (`/goal` gives one agent a condition to work toward; a session may have no goal, one or several, and is never named or labeled by one) + `session.goal_updated`, carrying the goal's status, and `session.goal_cleared` in [Spec-005](../specs/005-session-event-taxonomy-and-audit-log.md), each drawn only as a transcript system message |
| 18 | Session callback tools | [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) (registry shape) + [Spec-010](../specs/010-approvals-permissions-and-trust-boundaries.md) (Cedar governance) |
| 19 | Execution postures and sandbox profiles | [Spec-010](../specs/010-approvals-permissions-and-trust-boundaries.md) (`executionPosture` authorization semantics) + [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) (driver legs) |
| 20 | Voice (`/voice`) | [Spec-014 §Design Decisions](../specs/014-multi-agent-orchestration.md#design-decisions) (voice ships on both providers, with no reservation and no gate) + [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) (each provider's voice leg) + [Spec-021](../specs/021-desktop-app-and-renderer.md) (the composer's capture and the voice mode in the machine settings file): dictation into the composer through Anthropic's speech service on a Claude Code session, and Codex's own realtime voice call on a Codex session, talking started on both by holding Space or, after `/voice tap`, tapping it |
| 21 | Remote Control — linked devices, device liveness, and full parity from any device | [Spec-027](../specs/027-remote-control.md) |

A human step's timeout and every data act (export, erase, purge) ship in V1, as ADR-014 states after its V1 table.

## Out of Scope

The product has one user, so what exists only to sell to or govern an organization of other people is out of scope: enterprise sign-on (OIDC and SAML), compliance mappings (SOC 2, ISO 27001, HIPAA, FedRAMP), HSM custody, WAF, IDS and SIEM extensions, Helm charts, SLA support, multi-region sign-up discovery, and server-side telemetry. The app collects no usage analytics. The product builds no agent runtime of its own and no provider marketplace: V1 is Claude Code and Codex, and a later provider is admitted through [Spec-004 §Scope](../specs/004-provider-driver-contract-and-capabilities.md#scope)'s provider-admission contract.

## Deployment Options (V1)

Per [ADR-019: V1 Deployment Model and OSS License](../decisions/019-v1-deployment-model-and-oss-license.md), V1 is one open-source codebase whose relay is the person's own, deployed for themself in one of two ways:

- **The Workers relay, in the person's own Cloudflare account.** Cloudflare Workers and Durable Objects: nothing to keep running at home, and no open port. It counts requests on its sign-in routes in its per-identity Durable Object.
- **The Compose relay, on the person's own server.** Node, Caddy and Postgres from one `docker-compose.yml`: everything on hardware the person holds. It counts requests on its sign-in routes in memory.

The person picks per setup and can switch a machine between them; the daemon points at its relay through config (`RELAY_URL=…` or `--relay-url=…`). Both relays run one protocol and serve the same features, with one difference the person sees: shared ports in the web client exist only on the Compose relay, and on the Workers relay the web client says so. A machine signs in to its relay from the command line with `sidekicks sign-in`, the device-code flow, and a first run has nothing to answer ([Spec-022](../specs/022-first-run-onboarding.md)). Community-supported via GitHub Issues and Security Advisories; no SLA. A relay serving other people — a project-operated public relay, or a hosted service — is out of scope for one user.

## Platform Support (V1)

Per [ADR-018: Windows V1 Tier and PTY Sidecar Strategy](../decisions/018-windows-v1-tier-and-pty-sidecar.md), V1 ships Windows, macOS, and Linux as GA tiers on equal footing:

| Platform | V1 Tier | PTY Backend |
| --- | --- | --- |
| macOS (arm64, x64) | GA | `NodePtyHost` (in-process `node-pty`) |
| Linux (x64, arm64) | GA | `NodePtyHost` (in-process `node-pty`) |
| Windows 10/11 (x64) | GA | `RustSidecarPtyHost` (child-process Rust sidecar on `portable-pty`) |

Windows GA is contingent on the Rust PTY sidecar strategy in ADR-018, driven by the upstream `node-pty` ConPTY crash cluster (openai/codex#13973, microsoft/node-pty#904/#887/#894/#437/#647). Implementation detail lives in Plan-021. The `PtyHost` interface is declared in `packages/contracts/` so consumers never see the backend choice — see [Daemon Architecture §PTY Backend Strategy](./daemon.md#pty-backend-strategy).

On every platform a chat session's managed workspace, the git folder the daemon owns for it, lives at `<home>/.ai-sidekicks/workspaces/<session-id>`.

## Supporting V1 Specs (Cross-Cutting)

Cross-cutting V1 specs that multiple V1 features depend on. These are required by V1 but do not correspond to a single row in the table above.

| Spec | Coverage |
| --- | --- |
| [Spec-009](../specs/009-gitflow-pr-and-diff-attribution.md) | Gitflow, PR preparation, and diff attribution |
| [Spec-016](../specs/016-hosted-account-and-identity.md) | Hosted account and identity |
| [Spec-017](../specs/017-notifications-and-attention-model.md) | Notifications and attention model |
| [Spec-018](../specs/018-observability-and-failure-recovery.md) | Observability and failure recovery |
| [Spec-019](../specs/019-rate-limiting-policy.md) | Rate limiting policy (both backends ship in V1) |
| [Spec-020](../specs/020-data-retention-and-gdpr.md) | Data retention, export and deletion |
| [Spec-022: First Run](../specs/022-first-run-onboarding.md) | First run: nothing to answer, and when the daemon pins a relay's TLS key |

## Spec Coverage Assessment

- **V1 features:** each has a governing spec. Spec-015 (workflow authoring and execution) carries its SA-1…SA-22, SA-24, SA-25 and SA-26 items in its own body; SA-23, SA-27 and SA-28 live in Plan-014 as implementation detail.

## Backlog Coverage Assessment

All V1 features and supporting V1 specs have implementation plans: Plan-001 and Plans 002–019 for the existing V1 features (Plan-013 for Multi-agent orchestration and Plan-014 for workflow authoring and execution among them), Plan-020 for the desktop app, Plan-021 for the PTY sidecar and a session's shells, Plan-022 for Spec-024 MCP governance, and [Plan-025](../plans/025-remote-control.md) for Spec-027 Remote Control and for the machine's registration and reachability (feature 2, Phase 3). Spec-022's first run is built by the plans that own its pieces: Plans 005, 015, 020, 023 and 025.

## References

- [ADR-014: V1 Feature Scope Definition](../decisions/014-v1-feature-scope-definition.md) — the governing decision for this scope.
- [ADR-015: Electron Desktop App](../decisions/015-electron-desktop-app.md) — enables V1 feature 12 (Desktop GUI).
- [ADR-018: Windows V1 Tier and PTY Sidecar Strategy](../decisions/018-windows-v1-tier-and-pty-sidecar.md) — Windows V1 tier decision.
- [ADR-019: V1 Deployment Model and OSS License](../decisions/019-v1-deployment-model-and-oss-license.md) — the person's own relay and the ways to deploy it.
- [ADR-010: Tokens, Passkeys And The Remote Channel](../decisions/010-tokens-passkeys-and-the-remote-channel.md) — PASETO v4 tokens with a device-code sign-in and a DPoP-bound refresh token for the control plane, passkeys only in the web client, the phone apps and the device-code page, and the per-connection `Noise_KK_25519_ChaChaPoly_SHA256` channel between each device and each machine.
- [Vision](../vision.md) — signature features and build order.
- [Backlog](../backlog.md) — open work items against V1 scope.
- [Deployment Topology](./deployment-topology.md) — the topologies behind the person's own relay, on Workers or Compose.
- [Cross-Plan Dependencies](./cross-plan-dependencies.md) — the forward build order aligned against this scope.
