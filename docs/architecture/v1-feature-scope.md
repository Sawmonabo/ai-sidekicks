# V1 Feature Scope

## Purpose

This document records the V1 / V1.1 / V2 scope triage for the product. It is governed by [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md). Any change to the triage below requires an ADR update or supersession.

## V1 Features (16)

Every V1 feature has a governing spec. Cross-cutting V1 specs (identity, observability, rate limiting, data retention, relay) are listed separately in §Supporting V1 Specs below.

| # | Feature | Governing Spec(s) |
|---|---------|-------------------|
| 1 | Session creation and join | [Spec-001](../specs/001-shared-session-core.md) |
| 2 | Mid-session invites via shareable link | [Spec-002](../specs/002-invite-membership-and-presence.md) |
| 3 | Membership roles and permissions | [Spec-002](../specs/002-invite-membership-and-presence.md), [Spec-012](../specs/012-approvals-permissions-and-trust-boundaries.md) |
| 4 | Runtime node attach/detach | [Spec-003](../specs/003-runtime-node-attach.md) |
| 5 | Single-agent runs (Codex, Claude) | [Spec-005](../specs/005-provider-driver-contract-and-capabilities.md) |
| 6 | Queue, steer, pause, resume, interrupt | [Spec-004](../specs/004-queue-steer-pause-resume.md) |
| 7 | Approval gates | [Spec-012](../specs/012-approvals-permissions-and-trust-boundaries.md) |
| 8 | Repo attach and workspace binding | [Spec-009](../specs/009-repo-attachment-and-workspace-binding.md) |
| 9 | Worktree-based execution | [Spec-010](../specs/010-worktree-lifecycle-and-execution-modes.md) |
| 10 | Session timeline with replay | [Spec-013](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md), [Spec-015](../specs/015-persistence-recovery-and-replay.md) |
| 11 | Local daemon with CLI | [Spec-007](../specs/007-local-ipc-and-daemon-control.md) |
| 12 | Presence (online/idle/offline) | [Spec-002](../specs/002-invite-membership-and-presence.md) |
| 13 | Event audit log | [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md) |
| 14 | Artifact publication (local) | [Spec-014](../specs/014-artifacts-files-and-attachments.md) |
| 15 | Desktop GUI | Spec-023 (to be authored per BL-041) |
| 16 | Multi-Agent Channels | [Spec-016](../specs/016-multi-agent-channels-and-orchestration.md) (V1-readiness review per BL-042) |

## V1.1 Features (4, Deferred)

Features with a governing spec already written that defer implementation past V1 on well-named gates.

| # | Feature | Deferral Gate | Governing Spec(s) |
|---|---------|---------------|-------------------|
| 1 | MLS relay E2EE | Pending audit of an MLS implementation (OpenMLS-WASM, Wire core-crypto, or post-audit ts-mls); V1 ships pairwise X25519 + XChaCha20-Poly1305 per ADR-010 (rewritten under BL-048). | [Spec-008](../specs/008-control-plane-relay-and-session-join.md) |
| 2 | Email invite delivery | V1 uses shareable-link tokens; email delivery adds an external-service dependency with no category-positioning payoff for V1. | [Spec-002](../specs/002-invite-membership-and-presence.md) |
| 3 | Cross-node shared artifacts | Local artifact publication (feature 14) ships in V1; the shared-artifact relay layer is incremental scope on top of relay core. | [Spec-014](../specs/014-artifacts-files-and-attachments.md) (local portion is V1; cross-node is V1.1) |
| 4 | Workflow authoring and execution | V1 queue + approval gates + multi-agent channels cover the structured-execution use case; the dedicated workflow engine is incremental scope. | [Spec-017](../specs/017-workflow-authoring-and-execution.md) |

## V2 (Out of Scope for the V1 Horizon)

Any feature inferable from the product vision but not listed above — including but not limited to first-party native runtime, provider marketplace, mobile clients, enterprise OIDC/SAML flows, SOC 2 compliance artifacts, HSM-backed operator signing, and WAF / IDS / SIEM extensions — is V2 and re-evaluated only after V1 ships.

## Deployment Options (V1)

Per [ADR-020: V1 Deployment Model and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md), V1 ships over two deployment options — the same 16-feature surface runs in either; this is not a feature-count change to the triage above:

- **Free self-hosted (OSS).** Users obtain the product via `git clone`, `npm install`, Homebrew formula, or release-binary download. The daemon defaults to a project-operated free public relay at a published URL so first-run collaboration is zero-configuration. Users can override via config (`RELAY_URL=…` or `--relay-url=…`) to point at their own self-hosted relay. Community-supported via GitHub Issues and Security Advisories; no SLA.
- **Hosted SaaS.** The project operates the same codebase as a managed service at a separate URL. Users sign up, receive a scoped token, and their daemons point at the hosted control plane. Vendor-supported for paying customers.

Both deployment options ship the 16-feature V1 surface identically. The rate-limiter abstraction in `deployment-topology.md` §Rate Limiting By Deployment uses Cloudflare-native `rate_limit` for hosted and project-operated relay, and `rate-limiter-flexible` with Postgres for the self-hostable relay — both ship in V1. First-run UX presents a one-time three-way choice (free public relay / self-host / sign up for hosted) per Spec-026 (from BL-081).

## Platform Support (V1)

Per [ADR-019: Windows V1 Tier and PTY Sidecar Strategy](../decisions/019-windows-v1-tier-and-pty-sidecar.md), V1 ships Windows, macOS, and Linux as GA tiers on equal footing:

| Platform | V1 Tier | PTY Backend |
|----------|---------|-------------|
| macOS (arm64, x64) | GA | `NodePtyHost` (in-process `node-pty`) |
| Linux (x64, arm64) | GA | `NodePtyHost` (in-process `node-pty`) |
| Windows 10/11 (x64) | GA | `RustSidecarPtyHost` (child-process Rust sidecar on `portable-pty`) primary; `NodePtyHost` fallback |

Windows GA is contingent on the Rust PTY sidecar strategy in ADR-019, driven by the upstream `node-pty` ConPTY crash cluster (openai/codex#13973, microsoft/node-pty#904/#887/#894/#437/#647). Implementation detail lives in Plan-024 (per BL-078). The `PtyHost` interface is declared in `packages/contracts/` so consumers never see the backend choice — see [Component Architecture Local Daemon §PTY Backend Strategy](./component-architecture-local-daemon.md#pty-backend-strategy).

## Supporting V1 Specs (Cross-Cutting)

Cross-cutting V1 specs that multiple V1 features depend on. These are required by V1 but do not correspond to a single row in the table above.

| Spec | Coverage |
|------|----------|
| [Spec-008](../specs/008-control-plane-relay-and-session-join.md) | Control plane relay and session join (V1 uses pairwise X25519 + XChaCha20-Poly1305; MLS is V1.1) |
| [Spec-011](../specs/011-gitflow-pr-and-diff-attribution.md) | Gitflow, PR preparation, and diff attribution |
| [Spec-018](../specs/018-identity-and-participant-state.md) | Identity and participant state |
| [Spec-019](../specs/019-notifications-and-attention-model.md) | Notifications and attention model |
| [Spec-020](../specs/020-observability-and-failure-recovery.md) | Observability and failure recovery |
| [Spec-021](../specs/021-rate-limiting-policy.md) | Rate limiting policy (both backends ship in V1) |
| [Spec-022](../specs/022-data-retention-and-gdpr.md) | Data retention and GDPR compliance |
| Spec-024 (to be authored per BL-047) | Cross-node dispatch and approval |
| Spec-025 (to be authored per BL-079) | Self-hostable Node relay (V1 self-host deployment) |
| Spec-026 (to be authored per BL-081) | First-run three-way-choice onboarding |

## Spec Coverage Assessment

- **V1 features:** 14 of 16 have an existing governing spec. Spec-023 (Desktop Shell + Renderer) is to be authored per BL-041; Spec-016 (Multi-Agent Channels) gets a V1-readiness review per BL-042.
- **V1.1 features:** all 4 have a governing spec referenced above. The MLS spec surface (Spec-008) is being rewritten to declare pairwise-first for V1 and MLS as the V1.1 upgrade per BL-048.
- **V2 features:** intentionally uncovered. V2 scope decisions are made post-V1 and add specs as needed.

## Backlog Coverage Assessment

All V1 features have corresponding implementation plans (Plans 001–015, 018–020 for existing V1 features; Plan-021 per BL-044, Plan-022 per BL-045, Plan-023 per BL-043, Plan-024 per BL-078, Plan-025 per BL-080, Plan-026 per BL-082 for V1 items introduced by ADR-015 / ADR-019 / ADR-020). Tier assignments in `cross-plan-dependencies.md` align against ADR-015 per BL-054.

## References

- [ADR-015: V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md) — the governing decision for this triage.
- [ADR-016: Electron Desktop Shell](../decisions/016-electron-desktop-shell.md) — enables V1 feature 15 (Desktop GUI).
- [ADR-019: Windows V1 Tier and PTY Sidecar Strategy](../decisions/019-windows-v1-tier-and-pty-sidecar.md) — Windows V1 tier decision.
- [ADR-020: V1 Deployment Model and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md) — the two V1 deployment options.
- [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md) — relay encryption choice (pairwise-first V1, MLS V1.1 per BL-048 rewrite).
- [Vision](../vision.md) — signature features and build order.
- [Backlog](../backlog.md) — open work items against V1 scope.
- [Deployment Topology](./deployment-topology.md) — topologies supporting the two V1 deployment options.
- [Cross-Plan Dependencies](./cross-plan-dependencies.md) — tier graph aligned against this scope per BL-054.
