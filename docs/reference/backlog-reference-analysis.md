# Backlog Reference Analysis

**Date:** 2026-04-15
**Method:** 10 Opus 4.6 agents investigated all three reference apps (Forge, CodexMonitor, Paseo) via both reference docs and direct source code exploration, covering all 37 backlog items. A second wave of 10 Opus 4.6 research agents then conducted web searches across credible sources, docs, research papers, and popular GitHub repos for modern best practices as of April 2026. Raw research findings are in `.claude/tmp/research-*.md`.

---

## P0: Blocks All Implementation

### BL-001: Accept All 8 ADRs

- **Reference Apps**: No equivalent process. All three ship without formal ADR gates.
- **Recommendation**: Accept all 8 ADRs as-is. They reflect validated architectural decisions (session-first, local execution, daemon-backed queue, SQLite+Postgres, normalized drivers, worktree-first, layered trust, default transports). Check all plan precondition boxes. This is the single lowest-effort unblock.
- **Research**: The ai-sidekicks ADR template is more rigorous than industry standard (includes dialectic structure, trade-offs, alternatives). `adr-tools` CLI is the recommended management tool (not Log4brains, which defaults to MADR format that would lose the dialectic structure). The main action is updating the Status field from `proposed` to `accepted`. Sources: [ADR GitHub org](https://adr.github.io/), [Cognitect ADR blog](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
- **Final Recommendation**: Accept all 8 ADRs as-is using `adr-tools` for CLI management. The existing template exceeds industry standard — no changes needed. Status flip from `proposed` to `accepted`, then check all plan precondition boxes. This unblocks everything with zero risk.

### BL-002: Choose IPC Wire Format

- **Reference Apps**: All three use JSON serialization. None use protobuf or msgpack. Forge uses strict JSON-RPC 2.0 over Unix socket (with Effect RPC over WebSocket for browser). CodexMonitor uses simplified JSON-RPC (no `jsonrpc` field) over stdio/TCP. Paseo uses custom typed-message protocol with Zod discriminated unions over WebSocket.
- **Recommendation**: **JSON-RPC 2.0 over Unix domain socket** (named pipe on Windows), with WebSocket adapter for browser/remote clients.
- **Research**: MCP (Anthropic) and LSP (Microsoft) both chose JSON-RPC 2.0 for exactly this problem domain — local daemon-to-client IPC in TypeScript. This is the strongest ecosystem precedent. tRPC v11 (35k+ stars) and oRPC v1.0 lack built-in Unix domain socket adapters. V8's native `JSON.parse`/`JSON.stringify` outperforms JavaScript-level binary serializers (MessagePack) for typical IPC payloads. **Warning: Do NOT use `node-ipc`** — CVE-2022-23812 (severity 9.8), protestware incident. Use LSP-style Content-Length framing for message boundaries instead of newline-delimited. Build a thin typed SDK layer over JSON-RPC 2.0 (the MCP TypeScript SDK pattern, ~500-1000 LOC). Sources: [MCP spec](https://spec.modelcontextprotocol.io/), [LSP spec](https://microsoft.github.io/language-server-protocol/), [tRPC v11](https://trpc.io/).
- **Final Recommendation**: **JSON-RPC 2.0 over Unix domain socket with LSP-style Content-Length framing** (not newline-delimited — handles embedded newlines in JSON). Build a thin typed Zod SDK wrapper (~500-1000 LOC) following the MCP TypeScript SDK pattern. WebSocket adapter for browser/remote. `protocolVersion` field on every request. This is the superior choice because it has direct ecosystem precedent (MCP + LSP), avoids custom protocol risk, and V8's native JSON parsing outperforms alternatives.

### BL-003: Design Database Schemas

- **Reference Apps**: Forge is the only relational reference — 34 migrations, 18+ tables, event-sourcing + CQRS architecture. CodexMonitor uses flat-file JSON. Paseo uses file-backed JSON.
- **Recommendation**: Model the local SQLite schema after Forge's event-store + projection pattern.
- **Research**: Kysely + `better-sqlite3` (local) and Kysely + `pg` (control plane) is the production-grade stack. No event sourcing framework adoption needed — Emmett and Castore were evaluated but the domain requirements are too specific. SQLite WAL mode with `synchronous = NORMAL` and `wal_autocheckpoint = 1000` for append-heavy workloads. Kysely migrations with ISO 8601 prefixed filenames, frozen (no app imports), forward-only in production. Schema should include `compacted_at` column from day one for future compaction (BL-032). PII separation in payloads recommended from day one to enable future crypto-shredding (BL-036). Full topology: 14 local SQLite tables, 5 Postgres control-plane tables. Sources: [Kysely docs](https://kysely.dev/), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), [SQLite WAL docs](https://www.sqlite.org/wal.html).
- **Final Recommendation**: **Kysely + better-sqlite3 (local SQLite) and Kysely + pg (control plane Postgres).** Custom event store, no framework. WAL mode with `synchronous = NORMAL`, `wal_autocheckpoint = 1000`. Include `compacted_at` and PII-separated payload columns from day one for future compaction and crypto-shredding. This is superior to any framework because the domain (event-sourced collaborative runtime with local+remote split) is too specific for generic libraries.

### BL-004: Define API Payload Contracts

- **Reference Apps**: Forge has 20 branded entity IDs, 19 command schemas, 50+ RPC methods, all fully typed. Paseo has 75+ inbound and 60+ outbound Zod-validated message schemas. CodexMonitor has opaque `Value` returns (anti-pattern).
- **Recommendation**: Define contracts incrementally per spec using Zod with branded ID types.
- **Research**: Zod v4 confirmed as the right choice — fastest growing schema library, standard in TypeScript ecosystem. Critical architectural insight: **contracts must be split by transport protocol** — JSON-RPC method schemas for daemon (raw Zod `{params, result}` tuples), REST endpoint contracts (tRPC or ts-rest) for control plane. CloudEvents is NOT recommended for internal events (reserve for V1.1 external publishing). Use `z.discriminatedUnion("type", [...])` for O(1) parse-time dispatch across event types. Reject generic CRUD verbs (`*.updated`) in favor of intent-capturing names (`session.renamed`, `approval.granted`). Sources: [Zod v4](https://zod.dev/), [ts-rest](https://ts-rest.com/), [CloudEvents spec](https://cloudevents.io/).
- **Final Recommendation**: **Zod v4 with transport-split contract structure.** `packages/contracts/` organized as `daemon/` (JSON-RPC method schemas), `control-plane/` (REST endpoint schemas), `events/` (event payload schemas), `errors/` (error schemas). Branded ID types via `z.string().brand()`. This is superior to a monolithic contracts package because it enforces clean transport boundaries and enables independent evolution of daemon vs. control-plane APIs.

### BL-005: Specify Authentication and Token Model

- **Reference Apps**: Forge uses 256-bit hex bearer token. CodexMonitor uses TCP bearer token. Paseo trusts socket reachability + Curve25519 E2EE for relay. None have user identity systems.
- **Recommendation**: Three-tier auth model (socket trust, JWT/OAuth, E2EE relay).
- **Research**: **PASETO v4 over JWT** — eliminates algorithm confusion attacks by design (XChaCha20-Poly1305 local / Ed25519 public). Library: `paseto-ts` (active, 100% coverage, CF Workers). **WebAuthn/Passkeys as PRIMARY auth** — 15B accounts, 87% enterprise adoption. PRF Extension derives deterministic 32-byte key material from passkey, enabling E2EE key derivation during auth ceremony. Library: `@simplewebauthn/*`. **OAuth 2.1** (not 2.0): PKCE mandatory, implicit/ROPC removed. Device Auth Grant (RFC 8628) for CLI. **MLS (RFC 9420) for relay E2EE** — replaces NaCl box (see BL-023). Sources: [PASETO spec](https://paseto.io/), [paseto-ts](https://github.com/auth70/paseto-ts), [OWASP Auth Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), [WebAuthn PRF](https://www.corbado.com/blog/passkeys-prf-webauthn), [OAuth 2.1 draft](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/).
- **Final Recommendation**: **Three-tier with PASETO v4 + incrementally-deployed WebAuthn/Passkeys + MLS.** (1) Local daemon: socket reachability + 256-bit session token (mode 0600). (2) Control plane: auth deployed incrementally — Device Auth Grant (RFC 8628) + password/TOTP at CLI launch, WebAuthn/Passkeys (with PRF for E2EE key derivation) added at desktop launch, WebAuthn becomes recommended default for desktop users. OAuth 2.1 AuthCode+PKCE (browser) / Device Auth Grant (CLI). PASETO v4 tokens (access: v4.public/15min, refresh: v4.local/7d/rotated). DPoP sender-constraining. (3) Relay: MLS (RFC 9420) group E2EE with KeyPackage Ed25519 signature verification. (4) Invite tokens: HMAC-SHA256 signed, store SHA-256 hash only, single-use, 24h expiry. This is superior because PASETO eliminates JWT footguns, passkeys are phishing-resistant, and MLS provides forward secrecy + post-compromise security that NaCl box lacks.
- **Decision (2026-04-15)**: Auth resequenced. Device Auth Grant + password/TOTP is CLI-launch primary. WebAuthn/Passkeys added at desktop launch. Security architecture amended with incremental auth deployment, PASETO v4 token details, MLS relay encryption, and KeyPackage signature verification.

### BL-006: Produce Cross-Plan Dependency Graph and Ownership Map

- **Reference Apps**: No equivalent process. All three are built organically.
- **Recommendation**: Produce as a document with Mermaid diagram and ownership table.
- **Research**: Nx is the clear leader for TypeScript dependency visualization (`npx nx graph`). For plan-level (non-code) dependencies, no existing tool fits — custom YAML + Mermaid rendering is the right approach. Implementation ordering derives from topological sort of the dependency graph. Sources: [Nx docs](https://nx.dev/), [Mermaid](https://mermaid.js.org/).
- **Final Recommendation**: **Custom YAML dependency manifest + Mermaid rendering for plan-level, Nx for code-level.** Create `docs/dependency-graph.yaml` defining plan dependencies, owned tables, owned packages. Generate Mermaid DAG from YAML. Add Nx to the monorepo for runtime code dependency visualization. Topological sort determines implementation order.

---

## P0: Blocks Specific Critical Features

### BL-007: Add `pauseRun`/`steerRun` Driver Operations to Spec-005

- **Reference Apps**: **No reference app exposes pause or steer as provider-adapter-level operations.** Steer is an orchestration-layer construct in all apps. Pause is not implemented by any app at any level.
- **Recommendation**: Add generic `applyIntervention` instead of specific ops. Remove `pause` capability flag.
- **Research**: Vercel AI SDK 6's provider registry + middleware pattern validates the generic intervention approach. Mastra's layering (agent lifecycle over LLM abstraction) confirms ai-sidekicks' driver contract is a different abstraction layer than AI SDK/LangChain. The driver layer should be structured as a registry with capability-check middleware that short-circuits before unsupported interventions reach drivers. Sources: [Vercel AI SDK](https://sdk.vercel.ai/), [Mastra](https://mastra.ai/).
- **Final Recommendation**: **Generic `applyIntervention(type, payload)` with capability-check middleware.** Structure the driver layer as a provider registry (Vercel AI SDK pattern) with middleware that checks capability flags before routing. Drivers declare capabilities at registration; middleware rejects unsupported interventions with `degraded` before they reach the driver. Remove `pause` flag. This is superior to specific ops because it's extensible (new intervention types don't require driver interface changes) and matches the multi-provider abstraction layer established by Vercel AI SDK and Mastra.
- **Decision (2026-04-15)**: Confirmed. `applyIntervention` added to Spec-005 as 10th required driver operation. Existing operations (`interruptRun`, etc.) remain — `applyIntervention` dispatches to them. Relationship documented in Spec-005.

### BL-008: Complete Run State Machine Transition Table

- **Reference Apps**: Forge has 7 runtime + 7 projected states. Paseo has 5 states. No app has `recovering` or `interrupting`.
- **Recommendation**: Simplify to 9 states; drop `recovering` and `interrupting`.
- **Research**: No agent framework (LangGraph, Temporal, Mastra, Forge) uses `recovering` or `interrupting` as durable visible states. Temporal explicitly argues against exposing recovery as a state. **Hybrid implementation recommended: XState v5 for internal transition logic + TypeScript discriminated union for public API.** XState provides Stately Studio visualization, guard validation, and actor model composition. The discriminated union provides compile-time state narrowing that XState cannot. Sources: [XState v5](https://stately.ai/docs/xstate), [Stately Studio](https://stately.ai/), [Temporal docs](https://temporal.io/).
- **Final Recommendation**: **9 states with hybrid XState v5 + discriminated union implementation.** Internal: XState v5 state machine with guards, actions, and Stately Studio visualization for design-time verification. Public API: TypeScript discriminated union `type RunState = {state: "queued"} | {state: "running", turnId: string} | ...` for compile-time narrowing. Drop `recovering` (use startup reconciliation) and `interrupting` (synchronous provider call). Add `starting→failed`. Define interrupt paths from all blocking states. This is superior because it gives both runtime safety (XState guards prevent invalid transitions) and compile-time safety (discriminated unions narrow context per state).

### BL-009: Reconcile Intervention States Between Domain Model and Spec-004

- **Reference Apps**: No formal intervention state machine in any app. `degraded` maps to CodexMonitor's steer-fallback-to-queue.
- **Recommendation**: Unify to 6 canonical states: `requested`, `accepted`, `applied`, `rejected`, `degraded`, `expired`.
- **Research**: `degraded` is confirmed as project-original with zero external reference implementations. Graceful degradation is well-established (AWS Well-Architected, circuit breaker patterns), but as a named intervention state it is novel. Extra documentation and test investment required. Sources: [AWS Well-Architected](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/).
- **Final Recommendation**: **6 states confirmed, with `degraded` requiring explicit test coverage.** The 6-state model is correct. `degraded` needs: (1) exhaustive test cases for every intervention type × every unsupported-capability scenario, (2) documentation explaining the degradation path for each, (3) client-facing guidance on what the user sees when an intervention degrades. This investment is justified because the alternative (silently failing or throwing errors for unsupported interventions) is worse UX.

### BL-010: Specify Invite Delivery Mechanism

- **Reference Apps**: **Zero prior art.** No reference app implements invites.
- **Recommendation**: Shareable link with embedded invite token.
- **Research**: Store SHA-256 hash of token in Postgres (not raw token) — standard for OWASP-compliant token storage. Use HMAC-SHA256 signed tokens for stateless verification before database lookup. Constant-time comparison. Rate limit: token bucket, 10/hr collaborators, 50/hr owners. Slack and Discord both use shareable links with configurable expiry/max-uses. Sources: [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [Slack Security](https://docs.slack.dev/authentication/best-practices-for-security/).
- **Final Recommendation**: **HMAC-SHA256 signed shareable links with hashed storage.** Token = HMAC-SHA256(invite_id + session_id + role + expiration + 32-byte nonce). Store SHA-256 hash in Postgres. Constant-time verification. Single-use default. 24h expiry for real-time share, 7-day for email. Deep link: `ai-sidekicks://invite/{token}`. Rate limit: 10 creates/session/hour (collaborator), 50/hour (owner), 5 redemption attempts/IP/minute. This is superior to raw random tokens because HMAC enables stateless pre-validation before database lookup, reducing DB load under attack.

### BL-013: Resolve Sequence-Assignment Contradiction

- **Reference Apps**: Forge uses dual-counter (global AUTOINCREMENT + per-stream version with optimistic concurrency).
- **Recommendation**: Adopt Forge's dual-counter pattern.
- **Research**: The SoftwareMill gap problem (rolled-back transactions, out-of-order commits) does NOT apply to SQLite's single-writer model — sequences are gapless by construction. The real ordering challenge is cross-daemon event merge at the relay/control-plane level, solved by relay-assigned global positions at sync time. Sources: [SoftwareMill event store](https://softwaremill.com/implementing-event-sourcing-using-a-relational-database/), [SQLite WAL docs](https://www.sqlite.org/wal.html).
- **Final Recommendation**: **Dual-counter confirmed. Local sequences are gapless (SQLite single-writer). Cross-daemon merge is the real problem.** Global `sequence` (AUTOINCREMENT) for local total ordering. Per-stream `stream_version` with `UNIQUE(stream_id, stream_version)` for optimistic concurrency. For multi-daemon collaboration: the control plane assigns relay-global positions when events are synced, preserving causal ordering via causation/correlation IDs. Update both Spec-006 and Plan-006 to reflect this.

### BL-014a: Decide Workflow V1 Scope

- **Reference Apps**: Forge ships a production workflow engine. Paseo has loops/schedules (different paradigm).
- **Recommendation**: Workflows are V1, scoped to single-agent phases + auto-continue/done gates.
- **Research**: Arxiv paper "Rethinking the Value of Multi-Agent Workflow" (January 2026) directly validates single-agent phases — a single agent matches or exceeds homogeneous multi-agent workflows with better efficiency. V1 scope should be expanded to include `automated` phase type (shell commands, no LLM) and the full gate type set (quality-check and human-approval included) since Forge proves these are essential. LangGraph's StateGraph checkpoint pattern provides the persistence model. Do NOT add Temporal/Restate/Inngest as runtime dependencies — contradicts local-first architecture (ADR-002). Sources: [Arxiv multi-agent workflow](https://arxiv.org/), [LangGraph](https://langchain-ai.github.io/langgraph/), [Anthropic coordination patterns](https://docs.anthropic.com/).
- **Final Recommendation**: **Workflows are V1 with expanded scope: `single-agent` + `automated` phase types, all 4 gate types.** The Arxiv research validates that single-agent phases are the efficiency-optimal default. Adding `automated` (shell commands) costs almost nothing and enables quality-check gates. All 4 gate types (`auto-continue`, `quality-checks`, `human-approval`, `done`) should ship V1 because Forge proves they're essential for useful workflows. Defer `multi-agent` and `human` phase types to V1.1. Use LangGraph's checkpoint pattern for persistence, implemented on the existing SQLite store (not Temporal). Define the full type hierarchy now for extensibility.

---

## P1: Blocks Specific Features

### BL-011: Specify Channel Turn Policy, Budget Policy, and Stop Conditions

- **Reference Apps**: Forge has ping-pong deliberation with maxTurns, stall detection, and PROPOSE_CONCLUSION. Budget policy absent in all apps.
- **Recommendation**: V1: ping-pong + free-form turn policies. Defer budget to V1.1.
- **Research**: Add **orchestrator-directed** as a third turn policy — from Anthropic's orchestrator-subagent pattern, their top recommendation for multi-agent coordination. Three turn policies: `ping-pong`, `free-form`, `orchestrator-directed`. Stop conditions: `maxTurns`, `turnTimeoutMs`/`totalTimeoutMs`, and `stallDetection` with consecutive-no-progress counter. Budget: Langfuse and Bifrost identified as V1.1 integration targets for cost tracking. Sources: [Anthropic multi-agent patterns](https://docs.anthropic.com/), [Langfuse](https://langfuse.com/), [Bifrost](https://github.com/microsoft/bifrost).
- **Final Recommendation**: **Three turn policies (ping-pong, free-form, orchestrator-directed) with three stop condition types.** The orchestrator-directed policy is superior to just ping-pong + free-form because it matches Anthropic's recommended coordination pattern and maps directly to how users will build multi-agent workflows. Budget policy deferred to V1.1 with Langfuse/Bifrost integration path documented.

### BL-012: Enumerate Individual Event Types Within Taxonomy

- **Reference Apps**: Forge has 69 event types with payload schemas. Naming: `{aggregate}.{verb-past-tense}`.
- **Recommendation**: Enumerate ~50-70 types using `{category}.{verb_past_tense}` naming.
- **Research**: Reject generic CRUD verbs (`*.updated`, `*.deleted`) in favor of intent-capturing names (`session.renamed`, `approval.granted`). Use `z.discriminatedUnion("type", [...])` for O(1) parse-time dispatch. CloudEvents is NOT recommended for internal events — it adds envelope overhead without benefit when all producers and consumers are internal. Reserve CloudEvents for V1.1 external event publishing at system boundaries. Sources: [CloudEvents spec](https://cloudevents.io/), [Event Modeling](https://eventmodeling.org/).
- **Final Recommendation**: **~60-70 event types with intent-capturing names and `z.discriminatedUnion` dispatch.** Use `{aggregate}.{verb_past_tense}` naming (e.g., `session.created`, `run.paused`, `approval.granted` — never `session.updated`). Each type gets a Zod payload schema. Internal only — no CloudEvents envelope. This is superior because intent-capturing names make event streams self-documenting and prevent the "what changed?" ambiguity of generic update events.

### BL-014b: Expand Spec-017 Workflow Specification

- **Reference Apps**: Forge's complete type hierarchy: WorkflowDefinition, WorkflowPhase (4 types), PhaseGate (4 gate types, 3 failure behaviors), PhaseRun (5 statuses), GateResult (3 statuses).
- **Recommendation**: Expand Spec-017 with V1-scoped subset of Forge's hierarchy.
- **Research**: Full TypeScript type definitions provided for: 4 phase types, 4 gate types with `QualityCheckConfig` and `HumanApprovalConfig`, 4 output modes, gate failure semantics (retry with context injection, escalation paths, timeout actions). All phase execution routes through existing `OrchestrationRunCreate` per Spec-016/017 constraints. CI/CD quality gate patterns (direct analogy to workflow gates) validate the gate model. Sources: [LangGraph](https://langchain-ai.github.io/langgraph/), [Temporal workflow patterns](https://temporal.io/).
- **Final Recommendation**: **Define the full type hierarchy now, implement V1 subset.** Spec-017 should define all 4 phase types, all 4 gate types, and 4 output modes as the target architecture. V1 implements `single-agent` + `automated` phases, all 4 gates. The definition/execution entity separation (WorkflowPhaseId vs PhaseRunId) is essential from day one. All phase execution routes through existing `OrchestrationRunCreate`. This is superior to a minimal spec because it prevents type hierarchy rework when V1.1 adds multi-agent phases.

### BL-015: Define Per-Driver Capability Matrix

- **Reference Apps**: Paseo has 6 providers with capability flags. Forge has 2 adapters.
- **Recommendation**: Remove `pause`, keep 7 flags. Add matrix to Spec-005.
- **Research**: Remove `pause` from capability flags (7 flags, not 8) — no provider or agent framework implements true pause. Capability flags should be a versioned, additively extensible contract. Codex `steer` confirmed from primary Codex CLI docs. Sources: [Vercel AI SDK provider model](https://sdk.vercel.ai/).
- **Final Recommendation**: **7 capability flags, versioned and additively extensible.** Remove `pause`. The matrix (resume, steer, interactive_requests, mcp, tool_calls, reasoning_stream, model_mutation) goes into Spec-005 with per-driver values. Add `capabilityVersion: number` field to the contract for forward compatibility when new flags are added. This is the correct granularity — fine enough to drive fallback behavior, coarse enough to be stable across provider updates.
- **Decision (2026-04-15)**: Option A confirmed — `pause` removed from driver capability flags. Pause functionality exists as an orchestration-layer construct (interrupt → persist → queue resume). Spec-005 amended: `pause` removed from required flags, `applyIntervention` added as 10th driver operation, orchestration-layer pause pattern documented in examples.

### BL-016: Specify Owner Elevation, Last-Owner Departure, and Concurrent Membership Conflicts

- **Reference Apps**: Zero prior art. No app has ownership or membership.
- **Recommendation**: Owner elevation, orphan state, last-write-wins concurrency.
- **Research**: **Server-authoritative membership via Postgres with optimistic concurrency (version column).** CRDTs for ephemeral state (presence) ONLY — membership mutations are security-sensitive and must be serialized. Mutual revocation: both fail with 409, conflict surfaced. Session freeze + 24h TTL for last-owner departure, with optional auto-elevation of longest-tenured collaborator after 15-minute grace. CASL (`@casl/ability`, 6KB) for RBAC enforcement. Sources: [CASL](https://casl.js.org/), [Phoenix Presence](https://hexdocs.pm/phoenix/presence.html).
- **Final Recommendation**: **Postgres-serialized membership with CASL RBAC and session freeze for orphan recovery.** Membership is NOT CRDT-based (security-sensitive). Optimistic concurrency via version column. CASL for role-based permission checks. Owner elevation requires existing owner authorization. Last-owner departure: session freeze → 15-min auto-elevation grace → 24h archive TTL. Mutual revocation: 409 Conflict, surfaced to both parties. This is superior to CRDTs for membership because it guarantees consistency for security-critical operations.

### BL-017: Define Session, Channel, and Participant Limits

- **Reference Apps**: Forge has client-side caps. CodexMonitor has max_threads (1-12). Paseo has 200 items per agent.
- **Recommendation**: V1 defaults enforced server-side.
- **Research**: Higher limits than initially proposed: 50 participants, 20 channels, 10 concurrent runs, 25 agents, 5 child runs per parent, 100 pending invites. Dual enforcement (API gateway + orchestration layer). Monitor at 80% utilization. Sources: [Microsoft Capacity Planning](https://learn.microsoft.com/en-us/azure/well-architected/performance-efficiency/capacity-planning).
- **Final Recommendation**: **Higher limits with dual enforcement.** Max 50 participants, 20 channels, 10 concurrent runs, 25 agents, 5 child runs per parent, 100 pending invites. Configurable per session. Enforce at both API gateway and orchestration engine. Structured error responses include current count and limit. Alert at 80% utilization. These higher limits are superior because they accommodate real collaborative scenarios (large teams) without requiring limit-increase requests. The 50-participant limit is validated against relay sharding (25 connections per data DO, automatic sharding above that).
- **Decision (2026-04-15)**: Limits confirmed. 50-participant cap validated against relay DO sharding strategy (25 connections per data DO). Pre-launch load test required.

### BL-018: Add Handoff to Timeline Entry Types

- **Reference Apps**: No app has first-class handoff timeline entries. Forge has workflow phase-handoff. Paseo has skill-based handoff.
- **Recommendation**: Add `handoff` as a timeline entry type.
- **Research**: Agent handoffs are now first-class primitives in OpenAI Agents SDK, Anthropic Agent SDK, and Azure AI patterns. However, no existing tool renders them as timeline entries — all use trace trees (debugging-oriented). Add a `contextTokenCount` field to surface quadratic token cost at each handoff. Sources: [OpenAI Agents SDK](https://openai.com/), [Anthropic Agent SDK](https://docs.anthropic.com/).
- **Final Recommendation**: **Handoff as first-class timeline entry with `contextTokenCount`.** Fields: `fromAgentId`, `toAgentId`, `reason`, `contextSummary`, `contextTokenCount` (surfaces cost of context transfer). Visual: divider card showing transfer of responsibility with token cost badge. This is a novel UX — no reference app or framework renders handoffs this way — but it's validated by the trend of handoffs becoming first-class primitives in all major AI SDKs.

### BL-019: Specify Workspace-to-Worktree Binding State Transitions

- **Reference Apps**: No app implements dynamic mode switching. All set mode at creation.
- **Recommendation**: Make execution mode immutable at creation.
- **Research**: The 2025-2026 ecosystem (Claude Code `--worktree`, Worktrunk CLI) uses create-bind-use-remove with no dynamic switching. Git 2.46-2.50 improvements (porcelain output, worktree repair) strengthen the primitive. Add lifecycle tracking, post-creation hooks, and sidecar metadata. Sources: [Git worktree docs](https://git-scm.com/docs/git-worktree), [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code).
- **Final Recommendation**: **Immutable mode at creation confirmed. Add lifecycle tracking and sidecar metadata.** Mode set at creation (`read-only`, `branch`, `worktree`, `ephemeral-clone`). For mode switches, create a new workspace entity. Add: lifecycle tracking (created → ready → busy → retired), post-creation hooks (bootstrap scripts), and `.ai-sidekicks.json` sidecar metadata per worktree (session ID, run ID, base branch, creation timestamp). Ephemeral clone cleanup via `disposing` state with 1-hour default TTL.

### BL-020: Resolve DiffArtifact vs General Artifact Schema Relationship

- **Reference Apps**: Forge treats diff and design artifacts as parallel, independent schemas.
- **Recommendation**: Discriminated union with shared envelope.
- **Research**: OCI artifact manifest provides the exact reference architecture: shared envelope (id, digest, size, annotations) + `artifactType` discriminator + variant-specific payload. Maps to `z.discriminatedUnion('type', [...])` with branded types. Content-addressable storage (CAS) keyed by SHA-256 for automatic deduplication. Optional `subject` field for artifact linking (diff artifact referencing its parent run). Sources: [OCI artifact manifest spec](https://github.com/opencontainers/image-spec/blob/main/manifest.md).
- **Final Recommendation**: **OCI-inspired discriminated union with CAS.** Shared envelope: `{id: ArtifactId, sessionId, runId, digest: SHA256, size, artifactType, annotations, subject?, createdAt}`. Discriminated on `artifactType`: `"diff"`, `"design"`, `"file"`, `"log"`. CAS directory keyed by SHA-256 for deduplication. `subject` field for artifact linking. Plan-014 owns `artifact_manifests`; Plan-011's `diff_artifacts` references via FK. This is superior to Forge's parallel schemas because the shared envelope enables unified listing, querying, and lifecycle management across all artifact types.

### BL-021: Define Approval Category Canonical Enum

- **Reference Apps**: Forge has 8 request types. Paseo has 5 permission kinds. CodexMonitor has 3 informal categories.
- **Recommendation**: 8 canonical categories as a tagged union.
- **Research**: **Cedar policy engine** (now CNCF sandbox, WASM module for TypeScript) recommended for policy evaluation. Microsoft's Agent Governance Toolkit (April 2026, MIT, `@microsoft/agentmesh-sdk`) supports Cedar + OPA Rego + YAML with sub-millisecond enforcement. Cedar's principal-action-resource-context model maps perfectly to the approval system. The 8 categories align with OWASP agentic AI risks. Caveat: Cedar WASM is 2-5MB — prototype early to validate bundle size. Sources: [Cedar](https://www.cedarpolicy.com/), [Microsoft Agent Governance Toolkit](https://github.com/microsoft/agentmesh), [OWASP Agentic AI](https://owasp.org/).
- **Final Recommendation**: **8 categories with Cedar policy engine for evaluation.** Keep the 8 categories. Add Cedar (CNCF sandbox) as the policy engine — its principal-action-resource-context model maps directly to approval decisions. Start with YAML policy definitions for V1, Cedar WASM for V1.1 if bundle size is acceptable. Microsoft's `@microsoft/agentmesh-sdk` as a reference implementation. This is superior to hardcoded approval logic because Cedar policies are externalized, auditable, and can be modified without code changes.

### BL-022: Add Runtime Binding to Domain Glossary

- **Reference Apps**: Forge's `ProviderSessionRuntime` (8 fields). Paseo's `PersistenceHandle` per agent.
- **Recommendation**: Add glossary definition with 8 fields.
- **Research**: OTel GenAI semantic conventions (v1.37+) validate the proposed fields: `providerName` maps to `gen_ai.system`, `adapterKey` to `gen_ai.request.model`. The `resumeCursor` and `runtimePayload` are correctly opaque — OTel has no equivalents because they're session-recovery implementation details. Sources: [OTel GenAI Conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).
- **Final Recommendation**: **Glossary definition confirmed. Align field names with OTel GenAI conventions.** Add to glossary with 8 fields. Use OTel-aligned naming where possible (`gen_ai.system` as a metadata tag on the binding). Emit OTel spans when runtime bindings are created, recovered, and released. This enables integration with any OTel-compatible observability backend from day one.

### BL-023: Specify Relay Protocol

- **Reference Apps**: Only Paseo has a relay (Curve25519 ECDH + NaCl, Cloudflare Durable Objects).
- **Recommendation**: Adopt Paseo's model with improvements.
- **Research**: **MLS (RFC 9420) replaces NaCl box.** Forward secrecy, post-compromise security, O(1) sender group operations, replay protection built-in, IETF standard. Adopted by RCS/GSMA (March 2025), Apple Messages, Matrix. TypeScript: `ts-mls` (post-quantum ML-KEM + X-Wing, pure TS, CF Workers compatible). Crypto primitives: `@noble/curves` + `@noble/ciphers` (Trail of Bits audited, zero native deps, CF Workers). Cloudflare Durable Objects: WebSocket Hibernation API, 32 MiB max message, native `rate_limit` binding (GA Sep 2025). Fallback if MLS immature: X25519 + XChaCha20-Poly1305 with manual epoch rotation. Sources: [RFC 9420](https://datatracker.ietf.org/doc/rfc9420/), [ts-mls](https://github.com/LukaJCB/ts-mls), [noble-curves](https://github.com/paulmillr/noble-curves), [CF DO docs](https://developers.cloudflare.com/durable-objects/).
- **Final Recommendation**: **MLS (RFC 9420) over Cloudflare Durable Objects with WebSocket Hibernation and relay sharding.** Primary: `ts-mls` for group E2EE with forward secrecy and post-quantum support. KeyPackages distributed via control plane with Ed25519 signature verification. Wire: 4-byte length prefix + 1-byte type + MLS ciphertext. Relay: zero-knowledge, forwards opaque bytes, authenticates via PASETO, hibernates between messages. Sharding: control DO manages membership and routes connections; data DOs handle fan-out (max 25 connections each); automatic sharding when participants exceed threshold. Fallback: `@noble/curves` X25519 + `@noble/ciphers` XChaCha20-Poly1305 if `ts-mls` proves immature. This is vastly superior to NaCl box because it adds forward secrecy, post-compromise security, replay protection, and group scalability — all as an IETF standard.
- **Decision (2026-04-15)**: MLS confirmed with relay sharding strategy. Deployment topology amended with scaling section: 25 connections per data DO, automatic sharding, pre-launch load test requirement.

### BL-024: Specify Steer Injection Mechanics and Intervention Payloads

- **Reference Apps**: Codex `turn/steer` has `expectedTurnId` guard. Forge routes through guidance channel. Paseo has no steer.
- **Recommendation**: Discriminated union payloads with `expectedTurnId` on steer.
- **Research**: **All intervention types (not just steer) should carry version guards.** The `expectedTurnId` pattern is textbook optimistic concurrency control. Guard mismatch produces `expired` (target moved); authorization failure produces `rejected` (distinct semantics). Sources: [Optimistic concurrency control](https://en.wikipedia.org/wiki/Optimistic_concurrency_control).
- **Final Recommendation**: **Version-guarded discriminated union payloads for all intervention types.** Every intervention carries `expectedRunVersion` (not just steer). Steer adds `expectedTurnId` and `content` + `attachments`. Guard mismatch → `expired`; auth failure → `rejected`. This is superior to steer-only guards because it prevents all race conditions across all intervention types, not just steer.

### BL-025: Specify Presence Heartbeat Transport and Channel Discovery

- **Reference Apps**: Paseo has WebSocket heartbeat with 2-min stale threshold and multi-client attention routing.
- **Recommendation**: Adopt Paseo's model with 45s stale threshold.
- **Research**: **Yjs Awareness protocol** (`y-protocols`, ~3KB) is purpose-built for ephemeral presence CRDT — used by Notion, Figma, JupyterLab. 30s heartbeat (configurable to 15s), auto-cleanup on disconnect, standalone package with no coupling to Y.Doc. Redis Pub/Sub for cross-node fan-out. Shard by session ID. Phoenix Presence (CRDT-based, gossip-propagated) is the gold standard reference. Sources: [Yjs Awareness docs](https://docs.yjs.dev/getting-started/adding-awareness), [y-protocols](https://github.com/yjs/y-protocols), [Phoenix Presence](https://hexdocs.pm/phoenix/presence.html).
- **Final Recommendation**: **Yjs Awareness protocol for presence CRDT with Postgres LISTEN/NOTIFY fan-out.** Use `y-protocols` Awareness (~3KB) for ephemeral presence state over WebSocket. 15s heartbeat, 45s stale threshold. Presence metadata: `{status, focusedSessionId, focusedChannelId, lastActivityAt, appVisible, deviceType}`. Postgres `LISTEN/NOTIFY` for V1 cross-node fan-out, sharded by session ID. Redis Pub/Sub documented as V1.1 upgrade path. JSON-RPC bridge for local IPC (daemon exposes `PresenceUpdate`/`PresenceRead`). Channel discovery: `ChannelList` RPC + `channel.created`/`channel.closed` events. Auto-create well-known channels on session creation (`general`, `orchestration`, `system`). This is superior to custom heartbeat because Yjs Awareness is battle-tested at Notion/Figma scale with automatic conflict resolution and cleanup.
- **Decision (2026-04-15)**: Yjs Awareness + Postgres `LISTEN/NOTIFY` confirmed. No Redis in V1 — stays within the two-store architecture (SQLite local, Postgres shared). Spec-002 amended with presence implementation details, JSON-RPC bridge for local IPC, and Postgres fan-out.

### BL-026: Add Error Contracts to All Specs

- **Reference Apps**: Forge has full typed error hierarchy. Paseo has generic rpc_error. CodexMonitor has bare strings.
- **Recommendation**: Cross-cutting error contract with code namespaces.
- **Research**: **Two error formats required (transport-split).** RFC 9457 Problem Details (`application/problem+json`) for control plane REST API. JSON-RPC 2.0 error objects with domain-specific codes for daemon IPC. Add `retryable` and `retry_after` as standard extension fields on both formats. Custom minimal `Result<T, E>` type (~20 lines) for service-layer error handling (neverthrow is unmaintained as of 2025). Sources: [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457), [JSON-RPC 2.0 spec](https://www.jsonrpc.org/specification).
- **Final Recommendation**: **Dual-format errors: RFC 9457 (control plane) + JSON-RPC 2.0 (daemon).** Control plane REST: RFC 9457 Problem Details with `type` URI, `title`, `status`, `detail`, `instance`, plus extensions `retryable`, `retry_after`, `error_code` (namespaced: `auth.token_expired`, `session.not_found`, etc.). Daemon IPC: JSON-RPC 2.0 error with `code` (integer, domain-specific ranges), `message`, `data` (structured details + `retryable` + `retry_after`). Custom `Result<T, E>` (~20 LOC) for internal service layer. This is superior to a single format because it respects transport standards (RFC 9457 for HTTP, JSON-RPC for IPC) while maintaining consistent error semantics across both.

### BL-037: Specify Git Hosting Adapter Abstraction for PR Preparation

- **Reference Apps**: All three use `gh` CLI. Forge has cleanest abstraction (Effect-based service interface).
- **Recommendation**: `gh` CLI behind `GitHostingAdapter` interface.
- **Research**: Octokit (GitHub) and Gitbeaker (GitLab) are actively maintained TypeScript SDKs. No multi-host adapter library exists — custom abstraction required. Normalize terminology ("change request" not "PR"/"MR"). Auto-detect provider from remote URL. Host-specific metadata in extensions bag. **Agent Trace** (Cursor, January 2026, backed by Cloudflare/Vercel/Google Jules) is the emerging open standard for AI code attribution — JSON Schema + reference TypeScript implementation. Combine with git trailers (`Co-authored-by:`, custom `Agent-Run:`) for commit-level + line-level attribution. Sources: [Octokit](https://github.com/octokit), [Gitbeaker](https://github.com/jdalrymple/gitbeaker), [Agent Trace](https://agenttrace.org/).
- **Final Recommendation**: **`GitHostingAdapter` interface with `gh` CLI (V1) + Octokit/Gitbeaker SDK path (V1.1). Agent Trace for attribution.** V1: `gh` CLI subprocess behind typed interface. Normalize terminology (`createChangeRequest`, not `createPullRequest`). Auto-detect provider from git remote URL. V1.1: Octokit (GitHub) and Gitbeaker (GitLab) SDK implementations. Attribution: adopt Agent Trace standard + git trailers (`Agent-Run: <run-id>`, `Co-authored-by: <agent>`) for both commit-level and line-level provenance. This is superior because normalized terminology enables multi-host support without interface changes, and Agent Trace provides industry-standard attribution.

---

## P2: Should Resolve Before V1 Ship

### BL-027: Decide V1 Feature Scope for Reference App Capabilities

- **Reference Apps**: 20 features across all three apps.
- **Recommendation**: See table below.
- **Research**: Terminal: `node-pty` (Microsoft) + `xterm.js` (powers VS Code) + `react-xtermjs` is the fully validated stack. Context meters: Anthropic's free `POST /v1/messages/count_tokens` endpoint eliminates client-side tokenizer need. Provider fragmentation (2025-2026) validates deferring 5+ provider support. Sources: [node-pty](https://github.com/microsoft/node-pty), [xterm.js](https://xtermjs.org/), [Anthropic token counting](https://docs.anthropic.com/).
- **Final Recommendation**: No changes to the feature scope table. Research confirms all decisions. Terminal stack: `node-pty` + `xterm.js` + `react-xtermjs`. Context meters: use Anthropic's token counting API (free, billing-accurate). Relay E2EE upgraded to MLS per BL-023.

### BL-028: Create Domain Models for Workflow and WorkflowPhase

- **Reference Apps**: Forge separates definition-time from execution-time entities.
- **Recommendation**: Create domain models following Forge's separation.
- **Research**: Three domain models: Workflow (4 lifecycle: draft/published/deprecated/archived), WorkflowPhase (definition entity), PhaseRun (9 lifecycle states aligned with run state machine). LangGraph's checkpoint pattern for persistence. Do NOT add Temporal/Restate/Inngest — contradicts ADR-002 (local-first). Sources: [LangGraph](https://langchain-ai.github.io/langgraph/).
- **Final Recommendation**: **Three domain models with LangGraph-inspired checkpointing.** Workflow: draft → published → deprecated → archived. WorkflowPhase: definition entity with phase type, gate config, agent config. PhaseRun: pending → running → completed/failed/skipped (9 states). Checkpoint-and-recovery via existing SQLite persistence (Spec-015), not external workflow engines. This is superior to Temporal-based approaches because it maintains local-first execution per ADR-002.

### BL-029: Specify Control-Plane Transport Protocol

- **Reference Apps**: Forge uses WS + Unix socket. CodexMonitor uses Tauri IPC + TCP. Paseo uses WS + relay.
- **Recommendation**: HTTPS REST + WebSocket for streaming.
- **Research**: **tRPC v11** (35k+ stars, March 2025) provides zero-codegen type safety for request-response and SSE subscriptions. WebSocket required (not optional) for multi-user presence — SSE is unidirectional. The WebSocket collaboration channel reuses BL-002's JSON-RPC 2.0 + typed SDK pattern. oRPC v1.0 (Dec 2025) too immature. WebTransport (HTTP/3) not ready in Node.js. Sources: [tRPC v11](https://trpc.io/), [oRPC](https://orpc.dev/).
- **Final Recommendation**: **tRPC v11 (REST + SSE) for CRUD/subscriptions + WebSocket (JSON-RPC 2.0) for collaboration.** tRPC for: session CRUD, invite management, membership, settings (type-safe, SSE for real-time subscriptions). WebSocket for: presence, live event streaming, relay coordination (bidirectional, reuses daemon's JSON-RPC 2.0 pattern). This is superior to plain REST + WebSocket because tRPC provides end-to-end type safety with zero codegen, while WebSocket handles the bidirectional collaboration channel that SSE cannot.

### BL-030: Define Deployment Scaling and HA Strategy

- **Reference Apps**: No scaling or HA in any app. Paseo has NixOS systemd + CF Durable Objects.
- **Recommendation**: Single-process control plane, Postgres read replicas, CF Durable Objects relay.
- **Research**: **Neon managed Postgres** for HA (branching, scale-to-zero, instant provisioning). Self-hosted: Patroni or pg_auto_failover. Multi-stage Docker builds for containerization. KEDA for Kubernetes autoscaling. OpenTelemetry is the 2026 baseline for observability. Sources: [Neon](https://neon.tech/), [KEDA](https://keda.sh/), [OpenTelemetry Node.js](https://opentelemetry.io/docs/languages/js/).
- **Final Recommendation**: **Neon Postgres + Docker + KEDA autoscaling + OpenTelemetry.** V1: Neon managed Postgres (HA, branching for testing, scale-to-zero for dev), Docker multi-stage builds, stateless control plane behind load balancer. CF Durable Objects relay already scales. Self-hosted option: Patroni for Postgres HA. V1.1: KEDA autoscaling on Kubernetes. OpenTelemetry from day one (traces + metrics). This is superior to self-managed Postgres because Neon eliminates HA configuration complexity while providing branching for schema testing.

### BL-031: Add Concrete Commands and Thresholds to Operations Runbooks

- **Reference Apps**: Forge has 20+ CLI commands. Paseo has systemd integration. No SLO thresholds anywhere.
- **Recommendation**: Add CLI commands, detection thresholds, escalation routing after CLI is implemented.
- **Research**: SLIs: invite success rate, presence freshness, relay delivery latency, session join latency. OpenTelemetry for all metrics. Model after Google SRE runbook patterns. Sources: [Google SRE Book](https://sre.google/sre-book/), [OpenTelemetry](https://opentelemetry.io/).
- **Final Recommendation**: **OTel-instrumented SLIs with Google SRE-pattern runbooks.** SLIs: invite success rate (target: 99.9%), presence freshness (target: <5s P99), relay delivery latency (target: <200ms P95), session join latency (target: <3s P95). Each runbook gets: OTel dashboard link, CLI commands, quantified thresholds, escalation roles. Build after CLI implementation, not before.

### BL-032: Specify Event Compaction Policy

- **Reference Apps**: Zero compaction implementations. Forge's event store is append-only.
- **Recommendation**: Selective compaction with audit stubs. Implement post-V1.
- **Research**: Marten 8.0's stream compacting (May 2025) is the best production reference. Selective compaction of high-volume, low-audit-value events into audit stubs. Never compact lifecycle, membership, approval, or artifact events. Schema supports compaction from day one (`compacted_at` column, `event_snapshots` table). PII separation in payloads enables future crypto-shredding. Sources: [Marten 8.0](https://martendb.io/).
- **Final Recommendation**: **Marten-inspired selective compaction with schema-ready columns from day one.** Compaction targets: streaming deltas, presence heartbeats, tool call detail events. Never compact: lifecycle, membership, approval, artifact, audit events. Triggers: count > 10,000 per session or age > 30 days. Include `compacted_at` column and `event_snapshots` table in the initial schema. Implement compaction logic post-V1. This is superior to designing compaction later because the schema supports it from day one with zero migration cost.

### BL-033: Specify Rate Limiting for All APIs

- **Reference Apps**: Zero rate limiting. All single-user.
- **Recommendation**: Token bucket, 100 req/user/min.
- **Research**: **Two-layer: CF Workers native `rate_limit` binding (edge) + sliding window counters in Durable Objects (application).** CF native rate limiting: GA Sep 2025, zero latency, shared counters. Sliding window counters are the best balance of accuracy and memory for application-layer limits. Overflow: HTTP 429 + `Retry-After` + standard rate limit headers. Escalation: 3 violations in 5min → 15min block. Sources: [CF Workers Rate Limit](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [Arcjet comparison](https://blog.arcjet.com/rate-limiting-algorithms-token-bucket-vs-sliding-window-vs-fixed-window/).
- **Final Recommendation**: **Deployment-aware two-layer rate limiting.** Hosted (Cloudflare): CF Workers native `rate_limit` (edge) + sliding window in Durable Objects (application). Self-hosted: `rate-limiter-flexible` with Postgres backend for both layers. Same limits across all deployments: 100 req/user/min, 20 req/min auth endpoints, 30 req/min unauthenticated (edge); 10 invites/session/hr, 5 redemptions/IP/min, 20 sessions/user/hr, 1 heartbeat/sec, 60 messages/participant/min, 5 KeyPackage uploads/user/hr (application). HTTP 429 + `Retry-After`. Escalation: 3 violations/5min → 15min block, 10/1hr → 1hr block + ops alert. Rate limiting interface is deployment-agnostic; implementation swaps via configuration.
- **Decision (2026-04-15)**: Deployment-aware abstraction confirmed. CF native for hosted, `rate-limiter-flexible` with Postgres for self-hosted. Deployment topology amended with rate limiting section per topology.

### BL-034: Specify Context Window and Usage Meters

- **Reference Apps**: Forge has SVG ring meter + rate limit display. CodexMonitor has account-level usage. Paseo has neither.
- **Recommendation**: V1: token usage + rate limit in composer area.
- **Research**: Anthropic provides a free `POST /v1/messages/count_tokens` endpoint — billing-accurate, no client-side tokenizer needed. For OpenAI, `js-tiktoken` (WASM) gives exact counts. OTel GenAI Semantic Conventions (`gen_ai.token.usage.*`) define the standard telemetry schema — adopted by Datadog, Langfuse, Arize Phoenix. Sources: [Anthropic token counting](https://docs.anthropic.com/), [OTel GenAI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).
- **Final Recommendation**: **Provider-native token counting + OTel GenAI telemetry schema.** Use Anthropic's free token counting API (billing-accurate). Use `js-tiktoken` for OpenAI/Codex. Emit `gen_ai.token.usage.*` OTel metrics from provider drivers. UI: compact SVG ring (Forge reference) showing used/max tokens + rate limit status with threshold coloring. This is superior to client-side tokenizer-only because it uses billing-accurate counts and feeds the same metrics to both the UI and observability backends.

### BL-035: Specify Notification Delivery for Offline/Cross-Device

- **Reference Apps**: Paseo has daemon-side attention + Expo push. Forge has OS-native notifications. CodexMonitor has client-side Tauri notifications.
- **Recommendation**: V1: desktop notifications + deferred delivery. V1.1: mobile push.
- **Research**: Desktop: `node-notifier` or OS-native. Cross-device: Web Push API with `@pushforge/builder` (TypeScript-first, multi-runtime, Jan 2026) over aging `web-push` npm. iOS constraint: Background Sync unavailable in PWAs. Paseo's daemon-side attention suppression remains the best pattern — no better alternative found. Sources: [Web Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API), [@pushforge/builder](https://github.com/nicepkg/pushforge).
- **Final Recommendation**: **Daemon-side desktop notifications (V1) + Web Push via `@pushforge/builder` (V1.1).** V1: `node-notifier` for OS-native desktop notifications. Deep links (`ai-sidekicks://session/{id}`). Control plane stores undelivered notifications, delivered on next connection. Attention suppression per Paseo's heartbeat-based pattern. V1.1: Web Push API via `@pushforge/builder` for cross-device. This is the correct sequencing because desktop notifications are trivial and collaboration requires them from day one.

### BL-036: Specify Session Data Retention, Deletion, and GDPR Compliance

- **Reference Apps**: Zero GDPR code in any app. Forge has append-only event store with no deletion path.
- **Recommendation**: Data lifecycle policy with purge states. Implement post-V1, document before launch.
- **Research**: **Crypto-shredding** is the established pattern for GDPR deletion in event-sourced systems — encrypt PII with per-user keys, delete the key to "erase" data without mutating the event log. Dual-store architecture (Postgres + SQLite) is the hardest part. Postgres: hard-delete + anonymize. SQLite: crypto-shredding (per-user encryption keys for PII fields). No mature TypeScript GDPR library exists — custom implementation required. Data map across both stores is the prerequisite first action. Sources: [Crypto-shredding pattern](https://www.michielrook.nl/2017/11/forget-me-please-event-sourcing-gdpr/), [GDPR event sourcing](https://www.eventstore.com/blog/gdpr-and-event-sourcing).
- **Final Recommendation**: **Crypto-shredding for SQLite event log + hard-delete for Postgres.** PII fields in events encrypted with per-participant AES-256-GCM keys stored in a separate `participant_keys` table. Deletion = delete the key → PII becomes unrecoverable. Postgres: hard-delete participant records + anonymize references. Schema supports this from day one: PII fields stored in a separate `pii_payload` column (encrypted), non-PII in `payload` (plaintext). Data export: JSON of all participant's events (decrypted). Prerequisite: data map of PII across both stores. This is superior to purge-and-stub because it's the only approach that satisfies GDPR Article 17 (right to erasure) in an append-only event store without mutating the event log.

---

## Key Findings That Change the Plan

| Item | Previous Recommendation | Final Recommendation | Why Changed |
|------|------------------------|---------------------|-------------|
| **BL-002** | Newline-delimited JSON | LSP-style Content-Length framing | Handles embedded newlines; MCP/LSP precedent |
| **BL-005** | JWT + OAuth 2.0 + NaCl | PASETO v4 + WebAuthn/Passkeys + MLS (RFC 9420) | PASETO eliminates JWT footguns; passkeys are phishing-resistant; MLS adds forward secrecy |
| **BL-008** | 9-state flat implementation | 9-state hybrid (XState v5 internal + discriminated union public) | Dual representation gives both runtime and compile-time safety |
| **BL-014a** | Single-agent + auto-continue/done only | Single-agent + automated phases, all 4 gate types | Arxiv research validates single-agent; automated phases enable quality-check gates at near-zero cost |
| **BL-020** | Generic discriminated union | OCI-inspired envelope with CAS | OCI artifact manifests are the industry standard; CAS provides automatic deduplication |
| **BL-021** | Hardcoded approval logic | Cedar policy engine | Externalized policies are auditable and modifiable without code changes |
| **BL-023** | NaCl box (Paseo model) | MLS (RFC 9420) via ts-mls | Forward secrecy, post-compromise security, replay protection, IETF standard |
| **BL-025** | Custom heartbeat protocol | Yjs Awareness protocol | Battle-tested at Notion/Figma scale; purpose-built for ephemeral presence |
| **BL-029** | Plain REST + WebSocket | tRPC v11 (REST + SSE) + WebSocket (JSON-RPC 2.0) | tRPC provides end-to-end type safety with zero codegen |
| **BL-033** | Token bucket (single-layer) | Two-layer: CF native (edge) + DO sliding window (app) | Edge catches abuse before application; zero external dependencies |
| **BL-036** | Purge-and-stub | Crypto-shredding (per-participant AES-256-GCM keys) | Only approach satisfying GDPR Article 17 in append-only event stores |

## Key Technology Decisions

| Decision | Choice | Key Source |
|----------|--------|-----------|
| IPC wire format | JSON-RPC 2.0 + Content-Length framing | MCP spec, LSP spec |
| Schema validation | Zod v4 | Ecosystem standard |
| Local persistence | Kysely + better-sqlite3 (WAL mode) | SQLite docs |
| Control plane DB | Kysely + pg (Neon managed) | Neon |
| Auth tokens | PASETO v4 (internal), JWT (external only) | PASETO spec |
| Primary auth | WebAuthn/Passkeys + PRF extension | OWASP, FIDO Alliance |
| Relay encryption | MLS (RFC 9420) via ts-mls | RFC 9420 |
| Crypto primitives | @noble/curves + @noble/ciphers | Trail of Bits audit |
| State machine | XState v5 (internal) + discriminated union (public) | Stately.ai |
| Presence | Yjs Awareness (y-protocols) + Postgres LISTEN/NOTIFY (V1) | Yjs docs |
| RBAC | CASL (@casl/ability) | CASL docs |
| Rate limiting | CF native (hosted) / rate-limiter-flexible (self-hosted) | Cloudflare docs, rate-limiter-flexible |
| Control plane API | tRPC v11 (REST + SSE) | tRPC docs |
| Terminal | node-pty + xterm.js | Microsoft |
| Token counting | Anthropic API + js-tiktoken | Anthropic docs |
| Telemetry | OpenTelemetry GenAI conventions | OTel spec |
| Policy engine | Cedar (CNCF sandbox) | Cedar docs |
| Notifications | node-notifier (V1) + @pushforge/builder (V1.1) | Web Push API |
| GDPR | Crypto-shredding (per-participant AES-256-GCM) | Event sourcing + GDPR literature |
| Code attribution | Agent Trace + git trailers | Agent Trace spec |
| Artifact storage | OCI-inspired CAS (SHA-256) | OCI artifact manifest |
| Git hosting | gh CLI (V1) + Octokit/Gitbeaker (V1.1) | Octokit, Gitbeaker |
