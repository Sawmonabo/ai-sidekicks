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

#### BL-078: Write Plan-024 Rust PTY Sidecar

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- Depends-on: BL-052 (ADR-019 must land first; this plan implements the sidecar strategy it decides)
- References: [ADR-019](./decisions/019-windows-v1-tier-and-pty-sidecar.md) (from BL-052), [ADR-009](./decisions/009-json-rpc-ipc-wire-format.md), [deployment-topology.md](./architecture/deployment-topology.md) §Container and Packaging, [Spec-007](./specs/007-local-ipc-and-daemon-control.md) (daemon IPC context), [component-architecture-local-daemon.md](./architecture/component-architecture-local-daemon.md); reference impl: [wezterm/pty (`portable-pty`)](https://github.com/wezterm/wezterm/tree/main/pty); distribution precedent: `@esbuild/*` platform-package set.
- Summary: Author the implementation plan for the Rust PTY sidecar that ADR-019 names as the Windows primary backend. Scope: (1) Rust crate structure on `portable-pty` (wezterm) with a single binary target per platform; (2) sidecar IPC protocol — LSP-style Content-Length framing over stdio with a JSON control channel (`spawn`, `resize`, `kill`, `exit-code`, `ping`) and a length-prefixed binary data channel for stdout/stderr; (3) `PtyHost` TypeScript interface in `packages/contracts/` with two implementations (`RustSidecarPtyHost`, `NodePtyHost`) and a platform selector — sidecar primary on Windows, node-pty primary on macOS/Linux; (4) distribution via `@ai-sidekicks/pty-sidecar-{win32-x64,darwin-arm64,darwin-x64,linux-x64,linux-arm64}` packages following the `@esbuild/*` optionalDependencies + `os`/`cpu` filter pattern so `npm install` pulls only the correct binary; (5) Windows code-signing pipeline — Azure Trusted Signing primary, EV cert fallback (per ADR-019); (6) daemon-side supervisor (process lifecycle, auto-restart on crash, graceful shutdown, backpressure) tied to session lifecycle; (7) test matrix — clean spawn/resize/kill, PowerShell 7 regression coverage (guards `microsoft/node-pty#894` class), concurrent session stress, daemon-restart recovery, panic-in-sidecar crash handling, IPC framing fuzz; (8) CI build matrix (cross-compile Rust for all five platform targets); (9) observability (sidecar-emitted structured logs merged into daemon log stream, metrics for spawn latency and restart count).
- Exit Criteria: `docs/plans/024-rust-pty-sidecar.md` exists and conforms to the plan template; cites ADR-019 and ADR-009; Tier placement stated (expected Tier 2 — daemon-foundational; pairs with Plan-001 and Plan-007); `PtyHost` interface contract referenced from `packages/contracts/` scope; Windows signing pipeline step enumerated; CI cross-compile matrix named; no retrospective/amendment phrasing. Cross-plan-dependencies.md update is BL-054's scope, not this BL's.

#### BL-079: Write Spec-025 Self-Hostable Node Relay

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- Depends-on: BL-053 (ADR-020 must land first; this spec implements the self-host relay it commits to)
- References: [ADR-020](./decisions/020-v1-deployment-model-and-oss-license.md) (from BL-053), [Spec-008](./specs/008-control-plane-relay-and-session-join.md) (v2 relay protocol this spec implements in a second deployment), [deployment-topology.md](./architecture/deployment-topology.md) §Relay Scaling Strategy and §Rate Limiting By Deployment; secure-default exemplars: Caddy auto-HTTPS, Tailscale, Syncthing.
- Summary: Author the spec for a Node.js WebSocket implementation of the v2 relay protocol, shipped in the same repo as the project-operated relay code and deployable via a single-command `docker compose up`. Both the Cloudflare Workers + Durable Objects relay (project-operated) and the Node.js relay (self-host) implement the same v2 wire protocol behind one shared contract, so protocol-level changes land once and ship to both. Scope: (1) wire-protocol parity with Spec-008 (control socket + per-connection data sockets, encrypted fan-out, presence heartbeat); (2) in-process WebSocket pool replacing the data-DO sharding (configurable `MAX_CONNECTIONS_PER_PROCESS`, default 500); (3) rate-limiter-flexible Postgres backend (aligned with BL-044 dual-backend shipping); (4) auto-TLS via ACME (HTTP-01 + DNS-01, Caddy-style, per BL-060 secure-by-default behavior 1); (5) secure-by-default behaviors from BL-060 (bind-to-localhost, refuse-to-start without encryption, loud first-run banner, Prometheus `/metrics` endpoint); (6) `docker-compose.yml` that brings up Postgres + relay + reverse proxy (or skips the proxy in favor of built-in auto-TLS); (7) configuration surface (`RELAY_URL`, `BIND_ADDR`, `POSTGRES_URL`, `ACME_DOMAIN`, `ADMIN_TOKEN`); (8) admin surface (`/admin/bans`, `/admin/metrics`, `/admin/health`); (9) upgrade/migration story (how operators upgrade between relay versions); (10) security-defaults companion-doc pointer to `docs/operations/self-host-secure-defaults.md` (per BL-060).
- Exit Criteria: `docs/specs/025-self-hostable-node-relay.md` exists and conforms to the spec template; cites ADR-020 and Spec-008; wire-protocol section explicitly states "Spec-008 is authoritative; this spec is an alternate deployment of the same protocol"; `docker-compose.yml` reference present (file itself lands in BL-080 Plan-025); no retrospective/amendment phrasing.

#### BL-080: Create Plan-025 Self-Hostable Node Relay

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- Depends-on: BL-079 (Plan-025 implements Spec-025)
- References: [Spec-025](./specs/025-self-hostable-node-relay.md) (from BL-079), [ADR-020](./decisions/020-v1-deployment-model-and-oss-license.md), [Spec-021](./specs/021-rate-limiting-policy.md), [deployment-topology.md](./architecture/deployment-topology.md), [plans/000-plan-template.md](./plans/000-plan-template.md)
- Summary: Author the implementation plan for the self-hostable Node.js relay. Scope: module layout under `packages/relay-node/` (or `packages/control-plane/self-host/` if we fold it into the existing control-plane package), Node.js WebSocket server choice (`ws` vs `uWebSockets.js` — pick one with benchmark rationale), ACME integration library choice (`acme-client` or similar), rate-limiter-flexible wiring, Postgres schema for rate-limit state + admin bans, Docker Compose file landing at repo root or under `self-host/`, operator runbook outline, Tier placement (expected Tier 5–6, follows Plan-008 relay core).
- Exit Criteria: `docs/plans/025-self-hostable-node-relay.md` exists and conforms to the plan template; Spec-025 header's `Implementation Plan` field is populated; `docker-compose.yml` location + contents outlined (file itself is a plan deliverable); Tier intent stated so BL-054 can place it in the cross-plan graph; no retrospective/amendment phrasing.

#### BL-081: Write Spec-026 First-Run Three-Way-Choice Onboarding

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- Depends-on: BL-053 (ADR-020 commits to the three-way choice), BL-041 (Spec-023 Desktop Shell — desktop first-run UI lives here)
- References: [ADR-020](./decisions/020-v1-deployment-model-and-oss-license.md) (from BL-053), [Spec-007](./specs/007-local-ipc-and-daemon-control.md) (daemon lifecycle and config), [Spec-023](./specs/023-desktop-shell-and-renderer.md) (from BL-041 — desktop shell surface), [Spec-025](./specs/025-self-hostable-node-relay.md) (from BL-079 — self-host target)
- Summary: Author the spec for the one-time three-way-choice the daemon presents on first invite (or explicit activation): (1) Free public relay (default) — use the project-operated relay at a published URL; (2) Self-host your own — prompt for relay URL, admin token, CA bundle fingerprint for trust-on-first-use; (3) Sign up for hosted — open browser to sign-up flow, return scoped token via deep-link or local-loopback callback, store in OS keystore. Choice persists in daemon config (`$XDG_CONFIG_HOME/ai-sidekicks/config.toml` or equivalent), never re-prompts unless explicitly reset via CLI (`sidekicks config reset-onboarding`). Spec covers: CLI interaction flow (prompts, confirmations, help text); desktop interaction flow (modal + step-through, copy for each choice including the risk/benefit one-liner, accessibility); telemetry-opt-in flow (separate from but presented after the three-way choice); failure modes (no network, DNS failure on free relay, invalid self-host URL, sign-up canceled); observability (event taxonomy additions for `onboarding.choice_made`, `onboarding.choice_reset`). No enterprise-SSO flow in V1 (deferred to V1.1+ alongside any OIDC/SAML work).
- Exit Criteria: `docs/specs/026-first-run-onboarding.md` exists and conforms to the spec template; cites ADR-020, Spec-007, Spec-023, Spec-025; CLI flow and desktop flow both specified with copy or copy-intent for each choice; config persistence location stated; reset command named; event taxonomy additions listed; no retrospective/amendment phrasing.

#### BL-082: Create Plan-026 First-Run Three-Way-Choice Onboarding

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- Depends-on: BL-081 (Plan-026 implements Spec-026)
- References: [Spec-026](./specs/026-first-run-onboarding.md) (from BL-081), [ADR-020](./decisions/020-v1-deployment-model-and-oss-license.md), [Plan-023](./plans/023-desktop-shell-and-renderer.md) (from BL-043 — desktop implementation target), [plans/000-plan-template.md](./plans/000-plan-template.md)
- Summary: Author the implementation plan. Scope: CLI flow implementation under `apps/cli/` (tty prompt library choice, e.g., `@inquirer/prompts`; help-text copy; validation logic); desktop flow implementation under `apps/desktop/renderer/` (React component tree, preload-bridge hooks for keystore access, accessibility conformance); shared config read/write under `packages/client-sdk/` or `packages/contracts/`; telemetry-opt-in follow-on step; test matrix (golden-path three choices, no-network failure, invalid self-host URL rejection, reset-via-CLI flow, persistence across daemon restart). Tier placement follows Plan-023 / Plan-007 — expected Tier 7 or 8.
- Exit Criteria: `docs/plans/026-first-run-onboarding.md` exists and conforms to the plan template; cites Spec-026, ADR-020, Plan-023; Tier intent stated so BL-054 can place it; test matrix enumerated; no retrospective/amendment phrasing.

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

### Phase 3 — V1 Scope Decisions (P0 — resolved; ADR authoring remains)

Product/infra calls that required human judgment. Both items resolved 2026-04-16 after structured research (see `docs/research/`). Each item below is now scoped to ADR authoring + minimal doc propagation; the decision itself is recorded in the item body.

#### BL-052: Write ADR-019 Windows V1 Tier and Rust PTY Sidecar Strategy

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- Decision (resolved 2026-04-16): Windows ships in V1 as **GA** with a **Rust PTY sidecar** as the primary PTY backend on Windows. node-pty stays as the primary backend on macOS/Linux and as the fallback implementation on Windows. All PTY execution flows through a `PtyHost` interface in `packages/contracts/`. Research brief (evidence-grade, with citations): [bl-052-windows-tier-research.md](./research/bl-052-windows-tier-research.md).
- References: [v1-feature-scope.md](./architecture/v1-feature-scope.md), [vision.md](./vision.md) §"Add Later If Needed" (Rust sidecar row), [component-architecture-local-daemon.md](./architecture/component-architecture-local-daemon.md), [ADR-010](./decisions/010-paseto-webauthn-mls-auth.md) (Electron-for-Linux-passkey parity that frames the Windows GA expectation); upstream issues: `openai/codex#13973` (ConPTY assertion, OPEN 2026-03-08, first-party trigger), `microsoft/node-pty#904` (SIGABRT on Electron exit / ThreadSafeFunction race, OPEN), `microsoft/node-pty#887` (ConoutConnection worker strands Node exit, OPEN), `microsoft/node-pty#894` (PowerShell 7 3.5s delay under `useConptyDll`, OPEN), `microsoft/node-pty#437` (process-tree kill unreliable on Windows), `microsoft/node-pty#647` (spawn locks cwd on Windows); precedent: `Eugeny/tabby#10134` (GA ship on the same ConPTY assertion class caused a user-rollback wave — closed by pinning node-pty); reference impls: [wezterm/pty (`portable-pty`)](https://github.com/wezterm/wezterm/tree/main/pty), [Tauri v2 sidecar docs](https://v2.tauri.app/develop/sidecar/), npm distribution pattern mirrors `@esbuild/*` platform-package set.
- Summary: Write ADR-019 declaring Windows V1 = GA with a Rust PTY sidecar. The ADR must state: (1) **Primary backend on Windows is a Rust sidecar built on `portable-pty`** (wezterm), spawned as a child process of the daemon with lifecycle tied to the session. (2) **node-pty is the primary backend on macOS/Linux and the Windows fallback** under the same `PtyHost` interface (contract lives in `packages/contracts/`). (3) **Sidecar IPC uses LSP-style Content-Length framing over stdio**, with a JSON control channel (`spawn`, `resize`, `kill`, `exit-code`) and a length-prefixed binary data channel for stdout/stderr — this matches our existing daemon JSON-RPC 2.0 + Content-Length design (see [ADR-009](./decisions/009-json-rpc-ipc-wire-format.md)). (4) **Distribution** follows the `@esbuild/*` optionalDependencies + `os`/`cpu` filter pattern: one signed binary per platform under `@ai-sidekicks/pty-sidecar-{win32-x64,darwin-arm64,darwin-x64,linux-x64,linux-arm64}`. (5) **Windows code-signing** uses Azure Trusted Signing as the preferred path (eligible if 3+ years of verifiable business history), with a traditional EV cert (~$325–$581/yr) as the documented fallback. (6) **SmartScreen reputation** accrues to the signer, so the sidecar binary and Electron app share the same signing identity. Alternatives section must steel-man Option B (Windows GA on node-pty only — the industry norm across VS Code, Cursor, Windsurf, Tabby, Wave, Claude Code) and Option C (Windows V1 Beta — the research brief's default recommendation under a human-implementation cost model). The **decision rationale** must explicitly name the cost-model flip: the research brief recommended C because 3–5 engineer-weeks of Rust work and "+1 language in critical path" were treated as load-bearing costs; AI-implementation (Claude Opus 4.7) collapses those costs by >70%, which inverts the cost-benefit against the Tabby-precedent risk on `codex#13973`. Decision Log references the 2026-04-16 research brief and the AI-implementation cost-model shift. ADR text must read as a forward declaration — no "reversal," "rescope," "updated to," or other amendment framing.
- Exit Criteria: `docs/decisions/019-windows-v1-tier-and-pty-sidecar.md` exists with Context, Decision, Alternatives (B + C steel-manned; D `useConptyDll` noted as a flag that may be combined with the sidecar when `microsoft/node-pty#894` closes), Consequences, Reversibility, Tripwires, and Decision Log sections; status `accepted`; the ADR defines the `PtyHost` interface obligation and states that macOS/Linux continue on node-pty; Tripwires section names at least three reversal triggers (examples: sidecar-originated Sev-1 bug traceable to `portable-pty`; Azure Trusted Signing path unavailable AND EV cert blocked; node-pty v1.2.0 stable ships with the ThreadSafeFunction race fixed AND 50 consecutive clean `windows-latest` Codex+`/resume` CI runs → evaluate sidecar sunset as a cost-reduction move); `v1-feature-scope.md` Windows-tier row cites ADR-019 as GA; `vision.md` §"Add Later If Needed" Rust-sidecar row is moved to a confirmed V1 component row citing ADR-019; `component-architecture-local-daemon.md` defines the `PtyHost` interface and names the Rust sidecar as the Windows primary; the research brief is either copied to a persistent docs path or its key findings are inlined into the ADR's Decision Log with external-source URLs cited directly; no retrospective/amendment phrasing anywhere in the ADR body. Follow-up (tracked separately, not in this BL's scope): a dedicated plan (`Plan-024 Rust PTY Sidecar`) covering sidecar implementation, IPC protocol, distribution, and signing must exist before Plan-001 begins Windows integration testing.

#### BL-053: Write ADR-020 V1 Deployment Model (OSS Self-Host + Hosted SaaS) and OSS License

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- Decision (resolved 2026-04-16): V1 ships both deployment options over a **single codebase** under a **permissive OSS license**. (1) **Free self-hosted (OSS):** users `git clone` / install a distributed binary; the daemon defaults to a project-operated free public relay so first-run collaboration is zero-config; users can override to point the daemon at their own self-hosted relay. Community-supported via GitHub Issues, no SLA. (2) **Hosted SaaS:** the project operates the same codebase as a managed service users sign up for; their daemons point at our hosted control plane. Same feature set in both options (no feature-gating between free and hosted in V1). License starts **MIT or Apache-2.0**; revisit only on concrete competitive re-hosting signal (Sentry BSL/FSL precedent). Research brief: [bl-053-self-hosted-scope-research.md](./research/bl-053-self-hosted-scope-research.md). The brief's Option B recommendation (V1 hosted-only, defer self-host) was superseded after product-framing clarified this is OSS-first / "anyone can git clone and invite a friend," not an enterprise-commercial-SaaS — which eliminates the ongoing vendor-support cost argument that drove the brief's recommendation.
- References: [deployment-topology.md](./architecture/deployment-topology.md), [Spec-008](./specs/008-control-plane-relay-and-session-join.md), [Spec-021](./specs/021-rate-limiting-policy.md), [v1-feature-scope.md](./architecture/v1-feature-scope.md), [ADR-002](./decisions/002-local-execution-shared-control-plane.md) (trust-boundary framing), [ADR-004](./decisions/004-sqlite-local-state-and-postgres-control-plane.md) (Postgres control plane); research brief: [bl-053-self-hosted-scope-research.md](./research/bl-053-self-hosted-scope-research.md); one-product-two-deployment-options precedents: PostHog, Supabase, Sentry, GitLab, Mattermost, tmate (community relay + self-host); related to BL-044 (rate-limiter backend) and BL-060 (self-host security doc) — both now scoped by this decision.
- Summary: Write ADR-020 declaring the V1 deployment model. The ADR must state: (1) **Single codebase, two deployment options.** The daemon, the relay, and the control-plane code live in one repository under a permissive OSS license. Both deployment options ship the same 16-feature V1 surface — no feature-gating between free OSS and our hosted SaaS. (2) **Free self-hosted (OSS):** users install via `git clone` / npm / Homebrew / release binary; daemon defaults to a project-operated free public relay at a published URL so first-run collaboration is zero-config; users can override via an env var or config file (e.g., `RELAY_URL=…`) to point at their own self-hosted relay; community-supported via GitHub Issues and Security Advisories with no SLA. (3) **Hosted SaaS:** the project operates the same codebase as a managed service at a separate URL; users sign up, receive a scoped token, and their daemons point at the hosted control plane; vendor-supported for paying customers. (4) **First-run UX:** on first invite, the daemon presents a one-time three-way choice — free public relay (default) / self-host your own / sign up for hosted — stored in config, never re-prompts. (5) **License:** MIT or Apache-2.0 at repo root from day one. Revisit only if a competitor materially re-hosts our code as a competing managed service (the Sentry BSL→FSL saga is the precedent for deferred re-licensing). (6) **Relay infrastructure:** the project-operated free relay runs on Cloudflare Workers + Durable Objects using the sharded control/data-DO architecture from `deployment-topology.md` §Relay Scaling Strategy; the self-hostable relay is a Node.js WebSocket implementation of the same wire protocol, shipped alongside the daemon in the same repo with a `docker-compose.yml` for single-command self-host; both backends implement the v2 relay protocol behind one shared contract (so protocol-level changes land once and ship to both). (7) **Rate-limiter backends:** both ship in V1 under the deployment-aware abstraction already named in `deployment-topology.md` — CF-native `rate_limit` binding for the project-operated relay and hosted SaaS; `rate-limiter-flexible` with Postgres backend for the self-hostable relay. Alternatives the ADR must steel-man: (a) **Option Brief-B** (V1 hosted-only, V1.1 self-host) — the research brief's recommendation, superseded by the OSS-first product framing; (b) **Option Brief-A** (full enterprise self-hosted with Helm / OIDC / SAML / CVE contracts / vendor support) — rejected for V1 because no named enterprise pipeline today justifies the 0.2–1 FTE sustained cost; (c) **No default relay** (users must bring their own relay URL) — rejected because it breaks the "git clone and invite a friend immediately" UX; (d) **Pure P2P with STUN/TURN** — rejected because every ~30% NAT-blocked case still needs a relay fallback, so the architecture still ends up operating a coordination endpoint. The ADR's rationale must name the constraint that tipped the call: this is an OSS developer tool whose value is the tool itself, not an enterprise compliance wrapper. Vendor-supported-enterprise ongoing-cost arguments do not apply to community-supported OSS. Decision Log cites the research brief, the 2026-04-16 OSS-framing clarification, and the PostHog/Supabase/Sentry/tmate precedents. ADR body must read as a forward declaration — no "reconsidered," "expanded," or "changed direction" framing.
- Exit Criteria: `docs/decisions/020-v1-deployment-model-and-oss-license.md` exists with Context, Decision, Alternatives (a–d steel-manned), Consequences, Reversibility, Tripwires, and Decision Log sections; status `accepted`; Tripwires section names at least three reversal/adjustment triggers (examples: a competitor hosts our code as a competing managed service with measurable revenue impact → relicense to FSL/BSL/ELv2 per Sentry precedent; community support drag exceeds 30% of weekly engineering capacity for 4+ consecutive weeks → tighten OSS scope or deprecate the free default relay in favor of self-host-only; hosted-SaaS monthly active users stays below a named threshold 6 months post-launch → reconsider monetization shape before V1.1 planning); `v1-feature-scope.md` gains a "Deployment Options" section naming "Free self-hosted (OSS)" and "Hosted SaaS" as V1 deployment shapes (both over the same 16-feature V1 feature set — this is not a feature-count change to ADR-015); `deployment-topology.md` cross-links to ADR-020 from the Collaborative Hosted Control Plane and Collaborative Self-Hosted Control Plane topology rows (the topology model is unchanged; only the V1 commitment changes); an OSS `LICENSE` file (MIT or Apache-2.0) lands at the repo root; a `README` section documents the `--relay-url` / `RELAY_URL=` override and points at the self-host relay setup docs; the research brief (`docs/research/bl-053-self-hosted-scope-research.md`) is cross-linked from ADR-020 Decision Log with an explicit note that its Option B recommendation was superseded by the OSS-first product posture; no retrospective/amendment phrasing anywhere in the ADR body. Follow-up scope (now tracked as separate backlog items): (a) BL-079 (Spec-025 self-hostable Node relay) + BL-080 (Plan-025); (b) BL-081 (Spec-026 first-run three-way-choice onboarding) + BL-082 (Plan-026); (c) BL-083 (commit OSS `LICENSE` at repo root — MIT vs Apache-2.0).

#### BL-083: Commit OSS LICENSE file at repo root (MIT vs Apache-2.0)

- Status: `todo`
- Priority: `P0`
- Owner: `unassigned`
- Depends-on: BL-053 (ADR-020 commits to a permissive OSS license)
- References: [ADR-020](./decisions/020-v1-deployment-model-and-oss-license.md) (from BL-053); [MIT License](https://choosealicense.com/licenses/mit/); [Apache License 2.0](https://choosealicense.com/licenses/apache-2.0/); precedent — VS Code (MIT), Node.js (MIT), Supabase (Apache-2.0), Kubernetes (Apache-2.0), Terraform (originally MPL, now BSL), Mattermost (MIT + proprietary enterprise), PostHog (MIT → re-licensed), Sentry (originally BSD → BSL → FSL).
- Summary: Choose between MIT and Apache-2.0 and commit the corresponding `LICENSE` file at the repo root. Staff-level recommendation: **Apache-2.0**. Rationale: (1) explicit patent grant protects contributors and users from patent litigation by other contributors — a concrete advantage MIT does not give; (2) explicit contribution-terms clause codifies inbound-is-outbound CLA semantics in the license itself, reducing the need for a separate CLA; (3) dominant choice in modern OSS developer-tool projects (Kubernetes, Terraform-pre-BSL, Supabase, etc.); (4) SPDX-clean and recognized by all major dependency scanners. MIT remains a defensible choice if the constraint is maximal ecosystem compat with copyleft-aware downstream (GPL inclusion is cleaner under MIT than under Apache-2.0 due to the patent-termination clause in Apache-2.0 §3). Deliverables: (a) `LICENSE` file at repo root with text matching the chosen SPDX identifier exactly; (b) `package.json` top-level `license` field set to matching SPDX identifier (`Apache-2.0` or `MIT`); (c) README section naming the license and linking to `LICENSE`; (d) ADR-020 Decision Log entry recording which license was chosen and why. Revisit gate: if a competitor materially re-hosts the codebase as a competing managed service with measurable revenue impact, re-license to FSL/BSL/ELv2 per the Sentry precedent (already named in ADR-020 Tripwires).
- Exit Criteria: `LICENSE` file exists at repo root with text matching the chosen SPDX identifier exactly; `package.json` `license` field matches; `README.md` references the license; ADR-020 Decision Log entry records the choice; no conflicting license text anywhere in the repo.

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

#### BL-060: Implement secure-by-default behaviors for self-host deployment + companion doc

- Status: `todo`
- Priority: `P1` (parallel with early Plan-001 work)
- Owner: `unassigned`
- References: [deployment-topology.md](./architecture/deployment-topology.md), [Spec-007](./specs/007-local-ipc-and-daemon-control.md) (daemon lifecycle), [Spec-020](./specs/020-observability-and-failure-recovery.md) (metrics + update path), [Spec-021](./specs/021-rate-limiting-policy.md) (rate-limiter defaults), [Spec-022](./specs/022-data-retention-and-gdpr.md) (secrets / PII treatment), [ADR-010](./decisions/010-paseto-webauthn-mls-auth.md) (auth primitives), [ADR-012](./decisions/012-cedar-approval-policy-engine.md) (Cedar-deny metric source), [ADR-020 (from BL-053)](./decisions/020-v1-deployment-model-and-oss-license.md) (V1 deployment model that makes this item V1-scope); secure-default exemplars: Caddy auto-HTTPS (Let's Encrypt), Tailscale secure-by-default posture, Syncthing E2E-by-default, Supabase self-host auto-config.
- Summary: Self-host deployment must be secure by default — an OSS user who `git clone`s and runs the product should get a secure deployment without reading a hardening guide. Per the discussion recorded on 2026-04-17 during BL-053 resolution, BL-060 is retargeted from "enterprise-grade security requirements doc" to "ship the behaviors in the app, with a short companion doc covering what's default and how to opt into non-default modes." Ten secure-by-default behaviors ship in V1:
  1. **Auto-TLS for the self-hostable relay.** ACME integration (HTTP-01 + DNS-01) with auto-renewal, matching the Caddy auto-HTTPS model. If no public domain is reachable (LAN-only / dev use), generate a self-signed cert and emit its fingerprint on stdout for trust-on-first-use on the client side.
  2. **Refuse to start without encryption** on any non-loopback bind unless `--insecure` is set explicitly; when `--insecure` is set, print a loud startup banner so the operator can never silently run unencrypted.
  3. **Auto-generated strong secrets on first run.** Daemon and relay generate all required symmetric keys (session-signing, master key for at-rest encryption, relay admin token) via `crypto.randomBytes`, persist with `0600` permissions, and document the rotation schedule.
  4. **Bind to `127.0.0.1` by default** for all daemon/relay sockets; require explicit `--bind <addr>` (or `BIND_ADDR=`) to expose externally; reject `0.0.0.0` without TLS (see behavior 2).
  5. **Postgres TLS enforcement** (`sslmode=require`) for the self-host `rate-limiter-flexible` backend (per BL-044 dual-backend shipping); verify minimum Postgres version on startup; reject weak auth methods (md5, trust).
  6. **SQLite online-backup job** for daemon local state. Auto-rotate backups (default cadence: every session-end + nightly full); default destination is a `backups/` directory inside the daemon data dir; user-configurable via `BACKUP_DIR=` or a plug-in point for S3/GCS/similar.
  7. **Auto-update for daemon + CLI.** Desktop is covered by `electron-updater` in Plan-023 scope. Daemon + CLI self-update via a signed release manifest (GitHub Releases + Ed25519 signature on the manifest). Security patches apply with opt-out-only behavior for minors; majors require explicit user confirmation.
  8. **Minimum TLS 1.3** everywhere TLS is used; reject TLS ≤ 1.2 outright.
  9. **Security monitoring exports** on a Prometheus-compatible `/metrics` endpoint: token-auth-failure rate, rate-limit-trip rate, Cedar-deny rate (from ADR-012), relay connection-churn rate, backup-success counter, auto-update check status. Documented in the companion doc so self-hosters who scrape metrics know what signals to watch.
  10. **Loud first-run banner** summarizing auto-configured security posture (TLS mode + fingerprint if self-signed, bind address, backup destination, admin-token path, update channel). Single-screen overview on every fresh startup so the operator never has to grep files to know what they're running.

  Companion doc (`docs/operations/self-host-secure-defaults.md`, ~1–2 pages): for each behavior above, list (a) what's on by default, (b) how to opt out / override, (c) the one-line reason the default is what it is. No compliance-framework mapping (SOC 2 / ISO 27001 / HIPAA / FedRAMP) in this doc; those extensions are V1.1+ scope, to be authored if/when enterprise SaaS features ship.

  Out of scope for this BL (deferred to V1.1+): IdP / OIDC / SAML compatibility matrix; WAF recommendations; HSM for operator signing keys; SOC 2 / compliance-framework alignment; offline-root signing infrastructure; hardened-image signing (Cosign + SBOM) — all relevant for an eventual enterprise hosted tier but not for a V1 OSS self-host user.
- Exit Criteria: each behavior (1)–(10) has a passing integration test exercising the default path and, where applicable, the explicit-override path (e.g., `--insecure` on a non-loopback bind emits the warning banner and starts; a valid ACME HTTP-01 flow provisions a cert end-to-end in CI); `docs/operations/self-host-secure-defaults.md` exists with an entry per behavior and is cross-linked from `deployment-topology.md` and ADR-020; the self-hostable relay `docker-compose.yml` (shipped under the separate self-hostable-relay plan tracked as a BL-053 follow-up) starts with all defaults on and passes a new-user smoke test — `git clone` → `docker compose up` → invite a peer → collaboration succeeds with zero security configuration by the operator; a `--insecure` mode exists for local-dev convenience and is guarded by a prominent startup banner; no retrospective/amendment phrasing in the companion doc (it reads as a declarative description of current behavior, not as a changelog).

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
