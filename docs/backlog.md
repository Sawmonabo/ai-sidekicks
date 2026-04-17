# Backlog

## Purpose

This file is the active development backlog for the product defined in [vision.md](./vision.md).

## How To Use This Backlog

- Add items only when they represent real remaining work.
- Link every item to the governing spec, plan, ADR, or operations doc where possible.
- Keep items outcome-oriented. A backlog item should describe a deliverable, not a vague area of concern.
- Remove or rewrite stale items instead of letting the file become a historical log.
- When work is complete, update the canonical docs it depends on first, then move the item to [Backlog Archive](./archive/backlog-archive.md).

## Status Values

- `todo`
- `in_progress`
- `blocked`
- `completed`

## Priority Values

- `P0` — blocks all implementation or blocks a critical feature
- `P1` — blocks a specific feature or must resolve before v1
- `P2` — should resolve before v1 ship

---

## Active Items

This set was generated from the 2026-04-16 pre-implementation architecture audit (session ID `2026-04-16-arch-audit-163537`) and the V1 scope definition formalized in BL-038 (V1 consists of 16 features including Desktop GUI and Multi-Agent Channels; V1.1 defers MLS relay E2EE, email invite delivery, cross-node shared artifacts, and workflow authoring). Items are ordered by execution dependency: Phase 0 anchors downstream work; Phases 1–4 are P0 blockers for Plan-001 coding; Phases 5–6 can run in parallel with early Plan-001; Phase 7 is hygiene to land before V1 ship.

### Phase 0 — V1 Scope Anchor (P0)

Everything downstream depends on these landing first. Without the anchor, subsequent spec/plan edits drift.

#### BL-038: Write ADR-015 V1 Feature Scope Definition

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [v1-feature-scope.md](./architecture/v1-feature-scope.md), [vision.md](./vision.md), [BL-027 archive entry](./archive/backlog-archive.md) (prior V1 triage provenance)
- Summary: Write ADR-015 declaring the V1 feature scope. V1 consists of 16 features: Session creation and join, Mid-session invites, Membership roles, Runtime node attach/detach, Single-agent runs, Queue/steer/pause/resume, Approval gates, Repo attach, Worktree execution, Session timeline, Local daemon with CLI, Presence, Event audit log, Artifact publication (local), Desktop GUI, and Multi-Agent Channels. V1.1 defers MLS relay E2EE, email invite delivery, cross-node shared artifacts, and workflow authoring. The ADR text must read as a definition (no "expansion," "rescope," "now includes," or other retrospective/amendment phrasing). Alternatives section must steel-man at least: (a) a narrower V1 deferring Desktop GUI and Multi-Agent Channels, (b) a tiered M1–M4 milestone track. Decision Log references the 2026-04-16 audit (session `2026-04-16-arch-audit-163537`). BL-039 rewrites `v1-feature-scope.md` to cite this ADR.
- Exit Criteria: `docs/decisions/015-v1-feature-scope-definition.md` exists with Context, Decision, Alternatives, Consequences, Reversibility, and Decision Log sections; status `accepted`; the ADR body contains no retrospective/amendment phrasing (`rescope`, `expand V1`, `now includes`, `is being added`, `reversal`, `revert`, or similar).

#### BL-039: Rewrite v1-feature-scope.md against ADR-015

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- Depends-on: BL-038 (ADR-015 must exist for this doc to cite it authoritatively)
- References: [v1-feature-scope.md](./architecture/v1-feature-scope.md), [ADR-015](./decisions/015-v1-feature-scope-definition.md) (from BL-038)
- Summary: Rewrite the triage into a V1 / V1.1 / V2 three-way split consistent with ADR-015. V1 = 16 features per ADR-015. V1.1 = 4 features (MLS relay E2EE, Email invite delivery, Cross-node shared artifacts, Workflow authoring). V2 = out-of-scope for the foreseeable horizon. Update the Spec Coverage and Backlog Coverage Assessment paragraphs to reflect V1 = 16 features. The document must read as the authoritative V1 scope definition; do not use "expansion," "now includes," "moving to V1," or similar amendment phrasing.
- Exit Criteria: `v1-feature-scope.md` declares V1 = 16 features, V1.1 = 4 features, and V2 = out-of-scope; cites ADR-015 as the governing decision; references Spec-023 (from BL-041) for the Desktop GUI row; internal references to Spec-016 and Spec-017 reflect their V1 / V1.1 status; the document contains no retrospective/amendment phrasing and reads as a greenfield V1 definition to a first-time reader.

#### BL-040: Write ADR-016 Electron Desktop Shell (Tauri/Wails rejected)

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [vision.md](./vision.md) §Technology Position, [component-architecture-desktop-app.md](./architecture/component-architecture-desktop-app.md), audit artifact `tauri-wails-vs-electron-evaluation.md` (session 2026-04-16-arch-audit-163537)
- Summary: Write ADR-016 declaring Electron as the chosen desktop shell, with Tauri 2.x and Wails v3 evaluated as alternatives and rejected. Primary rejection reason: WebKitGTK has no WebAuthn support in 2026, which breaks the Linux passkey/PRF flow required by [ADR-010](./decisions/010-paseto-webauthn-mls-auth.md). Secondary reasons: solo-dev Rust/Go learning cost; documented cases of teams migrating from Tauri to Electron citing WKWebView vs WebView2 QA burden; Wails v3 still alpha with no flagship production apps. Include revisit triggers (WebKitGTK WebAuthn lands; team adds Rust-comfortable engineer). ADR text must read as a forward-declaration, not as a reversal of a prior shipped choice (no "keep Electron," "revert to Electron," or "rollback" framing — no desktop shell was previously chosen in code).
- Exit Criteria: `docs/decisions/016-electron-desktop-shell.md` exists with Context, Decision, Alternatives (Tauri 2.x and Wails v3 steel-manned), Consequences, Reversibility, and Decision Log sections; ADR status `accepted`; ADR body contains no amendment phrasing (`kept`, `reverted`, `rolled back`, `reversed`). This ADR subsumes the audit's Rec-28 paragraph-in-vision approach.

### Phase 1 — Spec & Plan Gaps in V1 (P0)

V1 (per ADR-015) includes a Desktop GUI feature with no governing spec today, and two cross-cutting V1 specs (Spec-021 rate limiting, Spec-022 data retention / GDPR) with no implementation plans. These specs and plans must exist before Plan-001 starts.

#### BL-041: Write Spec-023 Desktop Shell + Renderer

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [vision.md](./vision.md) §§1–2, [component-architecture-desktop-app.md](./architecture/component-architecture-desktop-app.md), [ADR-009](./decisions/009-json-rpc-ipc-wire-format.md), [Spec-007](./specs/007-local-ipc-and-daemon-control.md), [specs/000-spec-template.md](./specs/000-spec-template.md)
- Summary: Author a dedicated spec for Electron main/preload and React+Vite renderer. Cover: main-process responsibilities (windowing, native dialogs, notifications, auto-update, daemon supervision, deep-link handling for invite URLs); preload bridge surface; renderer→daemon IPC using the same JSON-RPC 2.0 contract as the CLI via the shared client SDK; trust stance (resolve renderer-trust contradiction per BL-056); code-signing + notarization; auto-update flow (electron-updater with delta patches).
- Exit Criteria: `docs/specs/023-desktop-shell-and-renderer.md` exists, conforms to spec template, and every Signature Feature view (timeline, approvals, invites, runs, multi-agent channels) has a composition sketch pointing to the owning plan.

#### BL-042: V1-Readiness Review of Spec-016 Multi-Agent Channels

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [Spec-016](./specs/016-multi-agent-channels-and-orchestration.md)
- Summary: Spec-016 (Multi-Agent Channels and Orchestration) is a V1 feature per ADR-015. Review it against the V1 quality bar: turn policy defaults (not just "configurable"), budget policy defaults, stop conditions, moderation/approval hooks, turn arbitration under partial network partition, and interaction with [ADR-011 intervention dispatch](./decisions/011-generic-intervention-dispatch.md). Tighten any ambiguous sections and promote "configurable" surfaces to named defaults.
- Exit Criteria: Spec-016 review note appended; tightening edits landed; spec status header explicitly declares V1 quality bar.

#### BL-043: Create Plan-023 Desktop Shell + Renderer

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- Depends-on: BL-041 (Plan-023 implements Spec-023)
- References: [Spec-023](./specs/023-desktop-shell-and-renderer.md) (from BL-041), [plans/000-plan-template.md](./plans/000-plan-template.md), [cross-plan-dependencies.md](./architecture/cross-plan-dependencies.md)
- Summary: Author the implementation plan for `apps/desktop/shell/` and `apps/desktop/renderer/`. Sequence the renderer foundation after the CLI proves the client SDK (per vision build-order step 6), but still inside V1. Slot into cross-plan tier 7 or 8 alongside timeline visibility (Plan-013) and artifacts (Plan-014).
- Exit Criteria: `docs/plans/023-desktop-shell-and-renderer.md` exists. (Cross-plan-dependencies.md tier-graph update is BL-054's scope; Plan-023's body states the tier intent.)

#### BL-044: Create Plan-021 Rate Limiting

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [Spec-021](./specs/021-rate-limiting-policy.md), [ADR-014](./decisions/014-trpc-control-plane-api.md), [deployment-topology.md](./architecture/deployment-topology.md)
- Summary: Author implementation plan for Spec-021. Scope: a `RateLimiter` abstraction swappable between Cloudflare native and `rate-limiter-flexible` Postgres-backed; per-endpoint enforcement on every control-plane tRPC + WS route; `/admin/bans` endpoint; three-stage escalation ladder (3 violations → 15-min block; 10 → 1-hr block; admin-issued permanent); ban-rate and false-positive-rate metrics.
- Exit Criteria: `docs/plans/021-rate-limiting.md` exists; Spec-021 header's "Implementation Plan" field no longer reads `_(none yet)_`. (Cross-plan-dependencies.md §5 tier-graph update is BL-054's scope; Plan-021's body states the tier intent and dependency on Plan-008.)

#### BL-045: Create Plan-022 Data Retention / GDPR

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [Spec-022](./specs/022-data-retention-and-gdpr.md), [local-sqlite-schema.md](./architecture/schemas/local-sqlite-schema.md) (`participant_keys`, `session_events.pii_payload`), [Plan-018](./plans/018-identity-and-participant-state.md)
- Summary: Author implementation plan for Spec-022. Scope: HKDF-SHA256 per-participant key derivation service; `participant_keys.encrypted_key_blob` + daemon master-key storage in OS keystore (libsecret / Keychain / DPAPI); AES-256-GCM encrypt/decrypt on `session_events.pii_payload` in the write path; purge state machine (`purge_requested → purged`); export endpoint (`GET /participants/{id}/data`); PII fan-out on shred. Pull this plan into Tier 2 at latest so encryption write-path ships with the first write.
- Exit Criteria: `docs/plans/022-data-retention-and-gdpr.md` exists and conforms to the plan template; Spec-022's header `Implementation Plan` field no longer reads `_(none yet)_` and links to Plan-022; Plan-022's body states the Tier 2 intent so BL-054 can place it correctly in the cross-plan dependency graph.

### Phase 2 — Architecture Blockers from the Audit (P0)

Doc edits that resolve convergent architectural gaps. None require code.

#### BL-046: Write ADR-017 Shared Event-Sourcing Scope

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [vision.md:157-173](./vision.md), [data-architecture.md](./architecture/data-architecture.md), [shared-postgres-schema.md](./architecture/schemas/shared-postgres-schema.md), [Spec-006](./specs/006-session-event-taxonomy-and-audit-log.md)
- Summary: Decide between Option A (add `session_events_shared` append-only Postgres table with MLS ciphertext envelopes and global-sequence protocol) and Option B (scope event-sourcing to per-daemon local runtime only; shared state stays row-based; cross-participant audit requires each peer's daemon). Recommendation: Option B for V1, Option A as a V1.1/V2 target if customer demand for shared audit emerges. The ADR documents the choice; the `data-architecture.md §Event-Sourcing Scope` section and the `vision.md §Session Engine` section (lines 157-173) are updated to match, so no downstream doc contradicts the ADR.
- Exit Criteria: `docs/decisions/017-shared-event-sourcing-scope.md` exists with the chosen option declared; `data-architecture.md` has §Event-Sourcing Scope reflecting the chosen option; `vision.md §Session Engine` (lines 157-173) is aligned so it does not promise cross-participant event-sourcing guarantees that the chosen option does not deliver.

#### BL-047: Write Spec-024 Cross-Node Dispatch and Approval

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [vision.md §Signature Features](./vision.md), [ADR-007](./decisions/007-collaboration-trust-and-permission-model.md), [ADR-012](./decisions/012-cedar-approval-policy-engine.md), [Spec-002](./specs/002-invite-membership-and-presence.md), [Spec-003](./specs/003-runtime-node-attach.md), [Spec-012](./specs/012-approvals-permissions-and-trust-boundaries.md)
- Summary: Author an end-to-end protocol for the signature mid-session-invite + cross-machine runtime contribution flow. Minimum content: Alice/Bob walk-through; target-node Cedar principal binding (`principal = verified_caller_sub`); dual-signed approval records (caller PASETO + target-owner PASETO); cross-node failure semantics on partner detach; capability declarations via `runtime_node.capability_declared` events with session-owner approval for dangerous classes; scheduler's own-node-first default with explicit cross-node hop requiring `tool_execution` approval.
- Exit Criteria: `docs/specs/024-cross-node-dispatch-and-approval.md` exists and conforms to the spec template; security-architecture.md cites Spec-024 from its Inter-Node Trust Boundaries section. The downstream addition of Spec-024 as an implicit dependency of Plan-002/Plan-003/Plan-008/Plan-012 in `cross-plan-dependencies.md` is BL-054's scope, not BL-047's.

#### BL-048: Rewrite ADR-010 — pairwise-first relay encryption; MLS is the V1.1 upgrade

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [ADR-010](./decisions/010-paseto-webauthn-mls-auth.md), [vision.md:280](./vision.md), [security-architecture.md](./architecture/security-architecture.md)
- Summary: Rewrite ADR-010 Decision point 3 to declare: "V1 ships pairwise X25519 + XChaCha20-Poly1305 via audited `@noble/curves` + `@noble/ciphers`. MLS (RFC 9420) via an audited implementation is the V1.1 upgrade path." Rewrite Assumption #2 to remove the unsupported "ts-mls is production-grade" claim and state instead that an audited MLS implementation (OpenMLS-WASM, Wire core-crypto, or post-audit ts-mls) is expected to be available for V1.1 promotion. Add explicit promotion gates: (a) external audit of selected MLS implementation, (b) interop tests pass against ≥ 1 other implementation, (c) ≥ 4 weeks production soak under a feature flag. Split security-architecture.md §Relay Authentication And Encryption into "V1 (pairwise X25519 + XChaCha20-Poly1305)" and "V1.1+ (MLS)" subsections; the V1 subsection is authoritative and stands on its own. ADR text declares the pairwise-first position as the forward choice, not as a reversal of a prior shipped default.
- Exit Criteria: ADR-010 declares pairwise-first as the V1 relay encryption choice with MLS as the V1.1 upgrade (with explicit promotion gates); `vision.md` Add table marks ts-mls as V1.1/V2 (also per BL-071); security-architecture.md has a V1 subsection that is self-contained and does not reference MLS; the ADR body contains no amendment phrasing (`invert`, `reversal`, `revert`, `rollback`, `the earlier default`). Additionally, sweep the corpus for residual "pairwise fallback," "NaCl fallback," "MLS fallback," and "fallback encryption" phrasings that describe the now-primary pairwise choice — update each to the declarative form. Known targets: `ADR-010` Success Metrics row, `vision.md:281` (`@noble/*` row purpose cell), `docs/architecture/v1-feature-scope.md` row 19 (MLS relay E2EE), and `docs/plans/008-control-plane-relay-and-session-join.md` encryption description. Post-edit grep for `fallback` in `docs/` must return no remaining references framing pairwise as fallback.

#### BL-049: Add Authenticated-Principal preamble to api-payload-contracts

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [api-payload-contracts.md](./architecture/contracts/api-payload-contracts.md), [Spec-012 §ApprovalResolve](./specs/012-approvals-permissions-and-trust-boundaries.md), [ADR-011](./decisions/011-generic-intervention-dispatch.md), [Spec-004 applyIntervention](./specs/004-queue-steer-pause-resume.md)
- Summary: Add a preamble to api-payload-contracts.md declaring that all control-plane endpoints are implicitly scoped to the authenticated `ParticipantId` from the PASETO `sub` claim and bound to the `cnf.jkt` DPoP thumbprint. Body fields that name a participant (`approver`, `inviter`, `requester`) are informational only. All local-daemon endpoints are implicitly authorized by socket reachability + optional session token. Then state explicitly in Spec-012 §ApprovalResolve and in ADR-011 / Spec-004 §applyIntervention that Cedar principal input = `verified_sub + cnf.jkt`.
- Exit Criteria: Preamble present; Spec-012 and ADR-011 / Spec-004 cite it; no payload doc reads as if `approver` is authoritative for authorization.

#### BL-050: Add Audit Log Integrity protocol

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [security-architecture.md](./architecture/security-architecture.md), [Spec-006](./specs/006-session-event-taxonomy-and-audit-log.md), [local-sqlite-schema.md](./architecture/schemas/local-sqlite-schema.md)
- Summary: Specify hash-chain + per-event daemon signature + periodic Merkle root anchored to control plane. Add `prev_hash`, `row_hash`, `daemon_signature` columns to `session_events` and a NULL-able `participant_signature` column for sensitive events (WebAuthn PRF at desktop, CLI at-rest key otherwise per BL-057). Anchoring cadence defaults: every 1000 events or 300 seconds (whichever first). Read-side verification rules cover hash chain, signature, and Merkle anchor.
- Exit Criteria: security-architecture.md has new §Audit Log Integrity; Spec-006 has §Integrity Protocol with canonical-serialization rules; schema migration note present for the four new columns (three required + one NULL-able).

#### BL-051: Add Idempotency Protocol for Side-Effecting Tool Calls

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- References: [Spec-006](./specs/006-session-event-taxonomy-and-audit-log.md), [Spec-015](./specs/015-persistence-recovery-and-replay.md), [Spec-005](./specs/005-provider-driver-contract-and-capabilities.md), [local-sqlite-schema.md](./architecture/schemas/local-sqlite-schema.md) (`command_receipts`)
- Summary: Define two-phase receipt commit (accept → execute → terminal-status) with each phase in its own transaction. Introduce driver metadata `tool.idempotency_class ∈ {idempotent, compensable, manual_reconcile_only}`. Recovery rule per class: idempotent re-executes (external de-dupe); compensable re-executes with dedupe key; manual_reconcile_only halts and surfaces operator escalation. Add new events `tool.replayed` and `tool.skipped_during_recovery` (feeds BL-064).
- Exit Criteria: Spec-006 and Spec-015 have the new sections; Spec-005 defines `tool.idempotency_class` in driver metadata; `command_receipts` schema gains the two-phase-commit support columns (`idempotency_class`, `dedupe_key`, `started_at`, `completed_at`). The pre-existing `status` CHECK constraint already enumerates `accepted | completed | failed | rejected`; verify rather than re-author.

### Phase 3 — Scope Decisions to Document (P0)

These are product/infra calls the team owes. Each unblocks downstream work.

#### BL-052: Decide Windows V1 tier (GA vs beta) and gate PTY sidecar

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- Requires: team/product decision (this item is not agent-resolvable; the GA-vs-beta call drives PTY-sidecar scope, CI matrix, and release-notes language).
- References: [v1-feature-scope.md](./architecture/v1-feature-scope.md), [vision.md:294-296](./vision.md) ("Add Later If Needed" Rust sidecar), [component-architecture-local-daemon.md](./architecture/component-architecture-local-daemon.md); upstream `openai/codex#13973` (ConPTY assertion bug, live as of 2026-03-08)
- Summary: Make the Windows V1 tier call. If GA: raise the Rust PTY sidecar from "later if needed" to "V1 contingency," with a decision gate at a named date driven by a Windows PTY integration test exercising node-pty + Codex resume. If beta: defer the sidecar and document the Codex-on-Windows limitation. Regardless of decision: add a `PtyHost` interface in `packages/contracts/` so node-pty is one implementation and a future sidecar can swap in.
- Exit Criteria: v1-feature-scope.md states the Windows tier; vision.md §Add Later If Needed gates the sidecar appropriately; component-architecture-local-daemon.md defines a `PtyHost` interface; if GA, a dated decision gate exists.

#### BL-053: Decide Self-Hosted V1 scope

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- Requires: team/product decision (this item is not agent-resolvable; the call gates BL-060 (self-hosted security requirements) and the rate-limiter backend choice in BL-044).
- References: [deployment-topology.md](./architecture/deployment-topology.md), [Spec-008](./specs/008-control-plane-relay-and-session-join.md), [Spec-021](./specs/021-rate-limiting-policy.md), [v1-feature-scope.md](./architecture/v1-feature-scope.md)
- Summary: Decide whether self-hosted control-plane deployment ships in V1 alongside the Cloudflare-hosted variant or is deferred to V1.1/V2. The choice gates BL-060 (security requirements doc) and the `rate-limiter-flexible` vs CF-native path in BL-044. Output: explicit row in `v1-feature-scope.md` naming self-hosted V1 status.
- Exit Criteria: v1-feature-scope.md names self-hosted V1 status; deployment-topology.md either includes a self-hosted subsection with requirements or defers it with a named target version.

### Phase 4 — Cross-Plan Propagation (P0 — directly unblocks Plan-001)

Propagate the scope anchor through the plan graph. Without this, implementers hit the scope contradiction on day one.

#### BL-054: Align cross-plan-dependencies.md with V1 = 16 and fix Tier 3 table-name drift

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- Depends-on: BL-038 (ADR-015 defines V1 = 16), BL-039 (v1-feature-scope.md is the canonical V1 definition), BL-041 (Spec-023 must exist to be cited), BL-043 (Plan-023 must exist), BL-044 (Plan-021), BL-045 (Plan-022), BL-047 (Spec-024 cross-node)
- References: [cross-plan-dependencies.md](./architecture/cross-plan-dependencies.md), [shared-postgres-schema.md](./architecture/schemas/shared-postgres-schema.md), [local-sqlite-schema.md](./architecture/schemas/local-sqlite-schema.md)
- Summary: Update the 9-tier graph so Plan-016 (multi-agent channels) sits inside the V1 tier set rather than Tier 9; place Plan-023 (desktop shell + renderer) after Plan-013; place Plan-021 (rate limiting, depends on Plan-008) and Plan-022 (data retention / GDPR, Tier 2 at the latest so encryption write-path ships with the first write); add Spec-024 (cross-node dispatch) as an implicit dependency of Plan-002/Plan-003/Plan-008/Plan-012. Fix the Tier 3 table-name drift: replace `runtime_nodes`, `node_attachments` with the schema-canonical `runtime_node_attachments`, `runtime_node_presence`. Update §1 Table Ownership Map and §5 Tier assignments consistently. Doc text should read as a greenfield V1 definition, not as "expanding" or "updating" a prior shipped graph.
- Exit Criteria: cross-plan-dependencies.md tier graph aligns with V1 = 16 per ADR-015; Plan-016 placed in the V1 tier set; Plan-021, Plan-022, Plan-023 present with correct tier slots; Spec-024 recorded as an implicit dep of Plan-002/Plan-003/Plan-008/Plan-012; Tier 3 table names match `shared-postgres-schema.md` and `local-sqlite-schema.md` exactly; the document contains no retrospective/amendment phrasing.

#### BL-055: Propagate V1 scope across all 20 plan files

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- Depends-on: BL-038 (ADR-015 is the citation target), BL-039 (v1-feature-scope.md is the scope-of-truth for the grep audit)
- References: `docs/plans/001-shared-session-core.md` through `docs/plans/020-observability-and-failure-recovery.md`, [ADR-015](./decisions/015-v1-feature-scope-definition.md) (from BL-038)
- Summary: Remove `V1.1 — deferred` / `V2 — deferred` markers on renderer sections across the 19 plans that carry them (Desktop GUI is a V1 feature per ADR-015, so these deferrals no longer apply). Add a single inline note in each plan pointing to ADR-015 for the canonical V1 definition. Resolve any remaining scope inconsistencies between plan bodies and `v1-feature-scope.md`. Plan text must read as a current V1 declaration, not as "this feature is being moved to V1" or "previously V1.1."
- Exit Criteria: grep for `V1\.1|V2|deferred` across `docs/plans/*.md` returns only intentional references (e.g., features genuinely deferred — MLS, email invite delivery, cross-node artifacts, workflow authoring); all 20 plan bodies cite ADR-015; no plan body contains retrospective/amendment phrasing about scope changes.

### Phase 5 — Security Hardening (P1 — parallel with early Plan-001 work)

Each surface below will be touched in the first implementation sprint.

#### BL-056: Resolve Desktop Renderer trust stance

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [container-architecture.md:71](./architecture/container-architecture.md), [security-architecture.md](./architecture/security-architecture.md) §Local Daemon Authentication, [Spec-023](./specs/023-desktop-shell-and-renderer.md) (from BL-041)
- Summary: Resolve the contradiction between container-architecture.md (renderer is "untrusted") and security-architecture.md (renderer is "a trusted local process"). Recommended: untrusted; Desktop Shell holds the session token and brokers per-channel capabilities to the renderer via the preload bridge; renderer never directly holds the PASETO token or Ed25519 DPoP key.
- Exit Criteria: Both docs state the same stance; Spec-023 renderer/shell IPC surface matches; no doc contradicts the choice.

#### BL-057: Specify CLI at-rest identity key storage

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [ADR-010](./decisions/010-paseto-webauthn-mls-auth.md), [security-architecture.md](./architecture/security-architecture.md), [Spec-008](./specs/008-control-plane-relay-and-session-join.md)
- Summary: Specify the fallback order for CLI identity key storage when WebAuthn PRF is not available: (1) OS-native keystore (libsecret / Keychain / DPAPI), (2) Argon2id-derived KEK from user password with explicit weaker-tier warning, (3) refuse to participate in shared-session E2EE. Specify rotation on daemon restart (opt-in), mandatory rotation on device reset, and stolen-key reuse detection (same Ed25519 pubkey from two machines simultaneously).
- Exit Criteria: ADR-010 has a new §CLI Identity Key Storage; security-architecture.md cites the fallback order; Spec-008 references the storage contract.

#### BL-058: Specify daemon master key storage + rotation + backup constraint

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-022](./specs/022-data-retention-and-gdpr.md), [security-architecture.md](./architecture/security-architecture.md), [local-persistence-repair-and-restore.md](./operations/local-persistence-repair-and-restore.md)
- Summary: Master key lives in OS keystore, never touches disk plaintext. Tied to participant credentials: WebAuthn PRF wraps the master key when available, Argon2id KEK otherwise. Wipe decrypted master key on idle (configurable grace) and on shutdown. Backups MUST NOT capture both `participant_keys` AND the plaintext master key; master key recovered from OS keystore separately. Rotate master key on every shred.
- Exit Criteria: Spec-022 has new §Daemon Master Key; security-architecture.md reflects the rotation policy; operations runbook's backup section names the separation constraint.

#### BL-059: Specify Cedar policy chain-of-custody

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [ADR-012](./decisions/012-cedar-approval-policy-engine.md), `docs/operations/` (new runbook)
- Summary: Policy sets are signed by an operator signing key (owner-org in hosted; org operator in self-hosted). Daemon only evaluates policies verifiable against a pinned operator public key bundled in the daemon image. Policy updates are atomic, versioned, signed; daemon rejects unsigned or unverifiable updates. On-start hash mismatch triggers fail-closed refusal to enforce approvals. V1 + V1.1 evaluation happens on the daemon; control plane is a signed-distribution channel only.
- Exit Criteria: ADR-012 has new §Policy Chain of Custody; `docs/operations/cedar-policy-signing-and-rotation.md` exists.

#### BL-060: Document Self-Hosted Security Requirements

- Status: `todo`
- Priority: `P1` (becomes `blocked` until BL-053 decides self-hosted V1 status)
- Owner: `unassigned`
- Depends-on: BL-053 (self-hosted V1 scope decision determines whether this item is V1-scoped or deferred to V1.1)
- References: [deployment-topology.md](./architecture/deployment-topology.md), [Spec-021](./specs/021-rate-limiting-policy.md), [ADR-012](./decisions/012-cedar-approval-policy-engine.md)
- Summary: Enumerate required edge protections (rate limiter per BL-044, WAF recommendation), IdP/OIDC compatibility matrix, operator signing-key management (HSM, offline root for BL-059 policy signing, rotation procedure), minimum TLS 1.3, monitoring exports (token-auth-failure, Cedar-deny rate, relay churn).
- Exit Criteria: `docs/operations/self-hosted-security-requirements.md` exists; deployment-topology.md links to it; if BL-053 defers self-hosted, this item is deferred too and marked accordingly.

### Phase 6 — Persistence Hardening (P1 — parallel with early Plan-001 work)

Each surface below is Plan-001-, Plan-004-, or Plan-006-adjacent.

#### BL-061: Specify SQLite writer concurrency model

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-015](./specs/015-persistence-recovery-and-replay.md), [component-architecture-local-daemon.md](./architecture/component-architecture-local-daemon.md), [data-architecture.md](./architecture/data-architecture.md)
- Summary: Pin `better-sqlite3` as V1 driver (production-recommended; `node:sqlite` still RC on Node 22/24). Single-writer discipline: one worker thread owns all writes; submitters post to bounded queue; worker drains in batched transactions (default 50 events or 10ms). Backpressure: submitter blocks at threshold. Drop policy: drop only `thinking_update` events when saturated; never drop canonical state-change events. Metric: `sqlite_queue_depth_p99` alert at 80% of cap.
- Exit Criteria: Spec-015 §Writer Concurrency exists; component-architecture-local-daemon.md references the writer module; data-architecture.md pins driver choice.

#### BL-062: Specify clock-handling strategy for event timestamps

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-015](./specs/015-persistence-recovery-and-replay.md), [local-sqlite-schema.md](./architecture/schemas/local-sqlite-schema.md) (`session_events.occurred_at`)
- Summary: Separate `monotonic_ns` (daemon uptime) from `wall_clock_iso`. Monotonic used for "happened after" within a daemon; wall clock for display. Require NTP sync as startup precondition; emit `clock_unsynced` warning event otherwise. Emit `clock_corrected` event on material skew detection. If BL-046 chooses Option A, add HLC column keyed to `(sequence, monotonic, wall)`.
- Exit Criteria: Spec-015 §Clock Handling exists; `session_events` schema adds `monotonic_ns` column; event taxonomy (BL-064) includes `clock_corrected` and `clock_unsynced`.

#### BL-063: Require automated SQLite backup policy

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-015](./specs/015-persistence-recovery-and-replay.md), [local-persistence-repair-and-restore.md](./operations/local-persistence-repair-and-restore.md)
- Summary: Automatic WAL checkpoint every 5 minutes or 1000 pages (whichever first). Full backup daily via `sidekicks db backup` triggered by daemon scheduler. Retention: 7 daily + 4 weekly. Storage: `$XDG_STATE_HOME/ai-sidekicks/backups/` with user-configurable remote sync path. Pre-migration automatic backup. Recovery SLO: restore from backup aged ≤ 24 hours.
- Exit Criteria: Spec-015 §Backup Policy exists; runbook references the automation (replacing "if a backup exists").

#### BL-064: Extend event taxonomy with missing types

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-006](./specs/006-session-event-taxonomy-and-audit-log.md)
- Summary: Add event types: `runtime_node.registered/online/degraded/offline/revoked`, `runtime_node.capability_declared/capability_updated`, `tool.replayed`, `tool.skipped_during_recovery` (from BL-051), `recovery.attempted/succeeded/failed`, `clock_corrected`, `clock_unsynced` (both from BL-062), `schema.migrated`, `event.compacted`, `event.shredded`, `participant.exported`, `participant.purge_requested`, `participant.purged`, `participant.tokens_revoked_all` (from BL-070), `participant.device_reset`, `key_reuse_detected` (from BL-057), `policy_bundle.loaded`, `policy_bundle.rejected` (from BL-059), `audit_integrity_failed` (from BL-050).
- Exit Criteria: Spec-006 enumeration includes all new types with payload schemas.

#### BL-065: Write ADR-018 Cross-Version Multi-Node Compatibility

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [data-architecture.md](./architecture/data-architecture.md), [Spec-006](./specs/006-session-event-taxonomy-and-audit-log.md) (`EventEnvelope.version`)
- Summary: `EventEnvelope.version` becomes the wire-format version. Clients MUST ignore unknown event types gracefully with a persisted audit stub that is re-interpretable on upgrade. Session metadata gets `min_client_version`; below-minimum clients can read but not write new events. Breaking envelope changes bump major; minor bumps require forward-compat (new optional fields only).
- Exit Criteria: `docs/decisions/018-cross-version-compatibility.md` exists; data-architecture.md has §Cross-Version Compatibility; Spec-006 documents `EventEnvelope.version` usage.

#### BL-066: Extend PII data-map fan-out on shred

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Spec-022](./specs/022-data-retention-and-gdpr.md), [Spec-020](./specs/020-observability-and-failure-recovery.md)
- Summary: Enumerate every PII-carrying path: `session_events.pii_payload`, bounded-retention diagnostic payloads (driver raw events, command output, tool traces), telemetry export (traces, logs), event signature payloads. `DELETE /participants/{id}/data` fans out to all paths; diagnostic TTL buckets get purged. Telemetry export redacts PII by default with explicit opt-in for raw content.
- Exit Criteria: Spec-022 §PII Data Map + §Shred Fan-Out exist; Spec-020 §PII in Diagnostics cross-references Spec-022.

### Phase 7 — Documentation Hygiene (P2 — batch into first implementation sprint)

Low-stakes cleanup. Some trivial, some require small edits across multiple docs. Batch when convenient.

#### BL-067: Swap paseto-ts library reference to panva/paseto

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [vision.md:278](./vision.md), [ADR-010](./decisions/010-paseto-webauthn-mls-auth.md)
- Summary: Replace `paseto-ts` with `panva/paseto`. Rationale: ~24× more weekly downloads, zero deps, maintained by the author of `jose` and `oidc-provider`. PASETO tokens are library-agnostic on the wire, so this is a drop-in swap at implementation time.
- Exit Criteria: vision.md Add table and ADR-010 both reference `panva/paseto`.

#### BL-068: Reframe Cloudflare Durable Objects scaling claims

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [deployment-topology.md:59-68](./architecture/deployment-topology.md), [vision.md:413](./vision.md)
- Summary: Rewrite "25 connections per DO" as a tunable design choice rather than a platform cap. State Cloudflare's actual limits (32,768 concurrent WS per DO; 1,000 rps soft cap) and explain the sharding rationale (keeping per-DO throughput well under rps cap when amortizing 100 events/sec/client × encrypt cost). Add a decision trigger for re-evaluating the sharding factor.
- Exit Criteria: deployment-topology.md distinguishes platform limits from design choices; vision.md Relay Scaling reference aligns.

#### BL-069: Specify local-only → shared session reconciliation

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [session-model.md](./domain/session-model.md), [shared-postgres-schema.md:13-21](./architecture/schemas/shared-postgres-schema.md)
- Summary: Define reconnect semantics: (a) session_id is preserved (daemon-assigned ULID/UUID used as-is); (b) Postgres `sessions` row created on first reconnect with `state='provisioning' → 'active'`; (c) owner identity comes from the first PASETO authentication at reconnect.
- Exit Criteria: session-model.md has new §Local-Only Reconciliation; shared-postgres-schema.md documents the id-preservation rule.

#### BL-070: Add refresh-token revoke-all-for-participant endpoint

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [security-architecture.md](./architecture/security-architecture.md) §Token revocation, [api-payload-contracts.md](./architecture/contracts/api-payload-contracts.md)
- Summary: Add `POST /auth/revoke-all-for-participant` for account-compromise recovery. Specify that refresh-token family-revocation list lives in Postgres and syncs across regions for multi-region self-hosted.
- Exit Criteria: security-architecture.md has the endpoint spec; api-payload-contracts.md includes the payload.

#### BL-071: V1/V1.1/V2 annotations on vision.md Add table

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [vision.md:276-293](./vision.md)
- Summary: Add a V1 / V1.1 / V2 column to every row of the Add table. Resolves ambiguity: Cedar WASM runtime = V1.1; YAML compile = V1; ts-mls = V1.1+ (post-audit, per BL-048); WebAuthn = V2 (desktop launch); push notifications transport = V1.1; notifications model = V1.
- Exit Criteria: Every row has an explicit V1/V1.1/V2 column value consistent with ADR-015 and ADR-010.

#### BL-072: Pin React 19 in vision

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [vision.md:263](./vision.md)
- Summary: Replace "React for the renderer" with "React 19 for the renderer" to pin the major version.
- Exit Criteria: vision.md names React 19.

#### BL-073: Clarify Agent Trace as emitted-spec, not imported library

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [vision.md:291](./vision.md)
- Summary: Change the vision Add table entry for Agent Trace to note "(spec, no npm library yet; we emit trace records against the Cursor-authored RFC pinned at revision X)".
- Exit Criteria: vision.md entry distinguishes emitted-spec from imported-library.

#### BL-074: Fill or remove ADR-013 reserved stub

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [ADR-013](./decisions/013-reserved.md)
- Summary: Either fill ADR-013 with a real decision or delete the placeholder. 161-byte reserved stubs are documentation debt.
- Exit Criteria: ADR-013 is either a substantive ADR or removed.

#### BL-075: Rename "Open Questions" sections to reflect V1 decisions

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: `docs/specs/*.md` with "Open Questions" sections
- Summary: Rename "Open Questions" sections that actually contain `V1 decision:` statements to "Resolved Questions and V1 Scope Decisions" (or move decisions to ADRs). Readers currently can't tell what's actually open.
- Exit Criteria: Every spec "Open Questions" section genuinely contains open questions; resolved items are relocated or renamed.

#### BL-076: Add decision trigger on 256MB daemon memory budget

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- References: [deployment-topology.md](./architecture/deployment-topology.md)
- Summary: Add instrumentation requirement (RSS metric with 80%-of-budget alert) and a decision trigger: "if real workloads consistently breach 256 MB, raise budget to 384–512 MB before considering a runtime change."
- Exit Criteria: deployment-topology.md states both the instrumentation requirement and the decision trigger.

#### BL-077: Promote plan status from `review` to `approved`

- Status: `todo`
- Priority: `P2`
- Owner: `unassigned`
- Depends-on: BL-038 through BL-055 (all P0 items). Promotion is a process-gate check; the approval pass should not run until every P0 item is landed.
- References: `docs/plans/*.md` headers
- Summary: After BL-038 through BL-055 land, run a formal approval pass and bump plan headers from `Status: review` to `Status: approved`. The approval pass verifies that each plan cites ADR-015 for V1 scope, matches the tier graph in `cross-plan-dependencies.md`, and contains no residual contradictions with the P0 outputs.
- Exit Criteria: All 20+ plan headers read `Status: approved`; no plan header carries a `Blocked-by` pointer to BL-038 through BL-055.

---

## Item Template

Use this shape for new backlog items:

```md
### BL-0XX: Short Title

- Status: `todo`
- Priority: `P1`
- Owner: `unassigned`
- References: [Relevant Spec](./specs/000-spec-template.md), [Relevant Plan](./plans/000-plan-template.md)
- Summary: One or two sentences describing the deliverable or change.
- Exit Criteria: Concrete condition that makes this item complete.
```

## Maintenance Rule

If information in a backlog item becomes durable product truth, move that information into the canonical docs and keep only the remaining work here.
