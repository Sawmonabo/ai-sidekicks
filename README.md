# AI Sidekicks

```text
      o
     .-.
  .--┴-┴--.
  | O   O |   >> A collaborative agent operating system for software work.
  | ||||| |   >> Humans + agents, one session.
  '--___--'
```

AI Sidekicks is a desktop runtime where humans and AI agents share live sessions, co-edit code through proper git flow, and collaborate in real time. Think of it as a group chat for agentic coding — a Discord-like shared session where you invite teammates mid-flight, everyone brings their own agents on their own subscription, and you steer agents as they work — within the session's roles and approvals. The shared object is the conversation, the activity, and the work product — never a mirrored screen or a forwarded keyboard.

<p align="center">
  <img src="assets/hero/desktop-app-hero.png" alt="AI Sidekicks Desktop App" width="100%" />
</p>

---

## Table of Contents

- [Why AI Sidekicks](#why-ai-sidekicks)
- [Core Concept](#core-concept)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [V1 Scope](#v1-scope)
- [Build Order](#build-order)
- [Project Status](#project-status)
- [Documentation](#documentation)
- [License](#license)

---

## Why AI Sidekicks

Today's AI coding tools are single-user, single-agent, and disconnected. You run one agent at a time, on your machine, against your checkout. There's no way to:

- Invite a colleague into a live agent session so they can see what's happening and contribute
- Run Claude and Codex side-by-side on the same task with coordinated git flow
- Pause an agent mid-run, steer its direction, then resume — without losing state
- Get real approval gates before agents install packages, run migrations, or push code
- See a unified timeline of every message, tool call, diff, and decision across all agents

AI Sidekicks exists to solve these problems. It treats **the session** — not the agent — as the first-class primitive, and builds real collaboration into the runtime from day one.

---

## Core Concept

The first-class object is not `agent`. It is **`session`**.

A session contains participants, agents, runs, channels, repo mounts, approvals, artifacts, invites, and presence. "Two agents talking," "one user chatting with one agent," and "workflow orchestration" are all different views over the same session and event model.

```text
                    ┌──────────────────────────────────┐
                    │           SESSION                │
                    │                                  │
                    │   Participants  ←  Humans        │
                    │   Agents       ←  Claude, Codex  │
                    │   Channels     ←  Chat, Workflow │
                    │   Runs         ←  Active work    │
                    │   Repo Mounts  ←  Git repos      │
                    │   Approvals    ←  Safety gates   │
                    │   Artifacts    ←  Diffs, files   │
                    │   Events       ←  Full timeline  │
                    │                                  │
                    └──────────────────────────────────┘
```

A participant can join a live session, chat directly in it, and attach one or more agents from their own local machine. People and machines are both first-class participants.

---

## Key Features

### Multi-User, Multi-Agent Sessions

Start a session, invite a teammate via shareable link, and both bring your own agents — each running on its owner's machine, billed to its owner's subscription, with credentials that never travel. Everyone follows the same live session timeline, and late joiners catch up on history backfilled by their peers. Steering, queueing, and orchestration are governed by the session's membership roles and approval policies — steering another owner's agent is a policy grant from that owner, never a default. Humans keep side channels and direct messages whose content agents are never given as context, and session content — messages, events, artifacts — is end-to-end encrypted per recipient in transit: the relay never sees plaintext. (Presence signals — who is online, focused, or typing — ride the control-plane presence channel as non-content metadata, not the relay.)

### Queue, Steer, Pause, Resume

Real runtime control — not UI illusions. The queue is daemon-backed. Steer is modeled as an intervention against an active run. Pause is a runtime state with persisted context. Resume continues from where the agent left off.

### Approval Gates

9 categories of approval gates (tool execution, file write, network access, destructive git, user input, plan approval, MCP elicitation, workflow gate, and human phase contribution) ensure agents never take unsupervised action on anything that matters. Approve, deny, or set remembered rules.

### Worktree-First Git Flow

Every coding run binds to a repo mount and execution mode: read-only, branch, worktree, or ephemeral clone. The default is **worktree** — agents work on isolated branches, produce attributed diffs, and prepare PRs without touching your main checkout.

### Live Timeline and Visibility

A unified event stream shows every message, tool call, approval, diff, state transition, and handoff across all agents and participants. Replay any session from its event log.

### Provider Drivers

AI agents run behind explicit driver adapters — `claude-driver` and `codex-driver` ship in V1. The product is not a wrapper around a single provider CLI; it's a runtime that normalizes agent behavior across providers.

### Local-First with Collaboration

Agent execution stays on your machine. The collaboration control plane handles auth, invites, presence, relay, and shared metadata — it never executes code. Single-user mode works fully offline.

---

## Architecture

```text
┌──────────────────┐     ┌──────────────────┐
│   Desktop Shell  │     │       CLI        │
│   (Electron)     │     │   (sidekicks)    │
└────────┬─────────┘     └────────┬─────────┘
         │         Typed SDK      │
         └────────────┬───────────┘
                      │ IPC (Unix socket / named pipe)
              ┌───────┴────────┐
              │  Local Runtime │
              │    Daemon      │
              │                │
              │  ┌──────────┐  │
              │  │ Session  │  │
              │  │ Engine   │  │
              │  ├──────────┤  │
              │  │ Provider │  │    ┌────────────────────┐
              │  │ Drivers  │──┼───►│ Claude / Codex API │
              │  ├──────────┤  │    └────────────────────┘
              │  │   Git    │  │
              │  │ Engine   │  │
              │  ├──────────┤  │
              │  │ SQLite   │  │
              │  └──────────┘  │
              └───────┬────────┘
                      │ tRPC + WebSocket
           ┌──────────┴──────────┐
           │  Collaboration      │
           │  Control Plane      │
           │  (Auth, Invites,    │
           │   Presence, Relay)  │
           │                     │
           │  ┌──────────────┐   │
           │  │  Postgres    │   │
           │  └──────────────┘   │
           └─────────────────────┘
```

**Desktop Shell** — Electron main process. Thin layer for windowing, native dialogs, notifications, and daemon supervision.

**CLI** — First client delivery track. Proves the typed SDK and IPC contract before the desktop UI ships.

**Local Runtime Daemon** — Machine-local execution authority. Owns provider processes, git worktrees, terminal sessions, tool execution, and local persistence (SQLite).

**Collaboration Control Plane** — Hosted or self-hosted service for auth (PASETO v4 + WebAuthn), invites, presence (Yjs Awareness CRDT), relay (E2E encrypted), and shared metadata (Postgres).

### CLI-First

The CLI (`sidekicks`) is the first client delivery track — it proves the typed SDK and IPC contract before the desktop UI ships.

<p align="center">
  <img src="assets/hero/cli-terminal-hero.png" alt="AI Sidekicks CLI" width="720" />
</p>

---

## Technology Stack

| Layer | Technology |
| --- | --- |
| Language | TypeScript (daemon, CLI, desktop, contracts) |
| Desktop Shell | Electron |
| Desktop UI | React + Vite |
| Local Database | SQLite (WAL mode, 55 tables) |
| Shared Database | Postgres (26 tables) |
| Auth | PASETO v4 (access + refresh), WebAuthn, DPoP |
| Relay Encryption | X25519 + XChaCha20-Poly1305 (V1), MLS RFC 9420 (V2) |
| State Machines | XState v5 |
| API Framework | tRPC v11 |
| IPC | Unix socket (macOS/Linux), named pipe (Windows) |
| Validation | Zod |
| Authorization | Cedar (policy-based) per [ADR-012](docs/decisions/012-cedar-approval-policy-engine.md) |
| Presence | Yjs Awareness protocol |
| Observability | OpenTelemetry |

---

## V1 Scope

V1 ships 23 core features across CLI and Desktop GUI per [ADR-015: V1 Feature Scope Definition](docs/decisions/015-v1-feature-scope-definition.md) (amended 2026-07-02 per the capability-enhancement campaign — was 17).

| # | Feature | Description |
| --- | --- | --- |
| 1 | Session creation and join | Foundational session primitive |
| 2 | Mid-session invites | Shareable link with PASETO token |
| 3 | Membership roles | Owner, admin, collaborator, viewer |
| 4 | Runtime node attach | Participants contribute local compute |
| 5 | Single-agent runs | Claude and Codex via provider drivers |
| 6 | Queue, steer, pause, resume | Real runtime control and interventions |
| 7 | Approval gates | 9 categories of human-in-the-loop safety |
| 8 | Repo attach | Bind sessions to git repositories |
| 9 | Worktree execution | Isolated branches per agent run |
| 10 | Session timeline | Unified event stream with replay |
| 11 | Local daemon + CLI | First client over the typed SDK |
| 12 | Presence | Online / idle / offline awareness |
| 13 | Event audit log | Event-sourced persistence backbone |
| 14 | Artifacts (local + cross-node) | Diffs, files, and attachments; shared artifacts stay fetchable while the publishing node is offline via an eager relay pin of E2EE ciphertext (ADR-015 amendment 2026-07-08; threat-model-scoped 2026-08-08 — see that ADR's §Decision Log for the two accepted V1 residuals and their named closure) |
| 15 | Desktop GUI | Electron shell + React/Vite renderer over the same typed SDK |
| 16 | Multi-agent channels | Cross-agent coordination primitives per [Spec-016](docs/specs/016-multi-agent-channels-and-orchestration.md) |
| 17 | Workflow authoring and execution | Full workflow engine with a visual node-graph builder, session/project/shared definition scopes, chat-invoked start (the intercepted `/workflow start` command, the composer affordance, and the `workflow_start` callback tool per [ADR-027](docs/decisions/027-chat-invoked-workflow-start.md)), and a park-and-recovery surface — a phase parked on a provider usage limit or a human wait is readable from one run-read and acted on through authorized run-cancel and run-resume operations, the resume carrying the audited definition re-pin — per [Spec-017](docs/specs/017-workflow-authoring-and-execution.md), [ADR-026](docs/decisions/026-visual-node-graph-workflow-authoring.md) |
| 18 | MCP server configuration and governance | Server-config CRUD, operator-managed trusted-server store, status/health probing, server OAuth per [Spec-028](docs/specs/028-mcp-server-configuration-and-governance.md) + [Plan-028](docs/plans/028-mcp-server-configuration-and-governance.md) (landed 2026-07-22 via campaign B18; audit-cleared 2026-08-12 via Plan-028's targeted readiness audit, §6 node NS-61, and promoted `approved` 2026-08-14 by its §Rollout Order step-2 promotion — code dispatches in tier order per Plan-028 §Preconditions) |
| 19 | Session time-travel | Run rollback as a version-guarded intervention + forward `run.rolled_back` event (log never truncates) — governing amendments in-tree (B2 merged via #205, B1 merged via #173; Spec-004 + Spec-006 re-promoted `approved` 2026-07-18 via the W1.5 gate), and durable file restoration needed the B21→B23 turn-snapshot leg gated before Plan-004 Phase 3 (Codex rollback reverts conversation only) — the B23 leg shipped 2026-08-09 via PR #303, so that gate is met and rollback dispatch — Plan-004's Phase-3B explicit-label supplement since the NS-69 round-1 re-home — rides tier order plus its precondition legs — and the user-visible superseded-turn timeline rendering rides the Spec-013/Plan-013 CP-004-13 consumer leg (flipped `review` 2026-07-20; restored `approved` 2026-08-10 by the Tier-8 plan-readiness audit, NS-20; built at Plan-013's Tier-8 dispatch) |
| 20 | Session goals | Per-session structured goal with set/clear RPC and goal events — governing amendments in-tree (B6 landed 2026-07-06; B1 merged via #173) — specs re-promoted `approved` 2026-07-18 (W1.5 gate cleared) |
| 21 | Session callback tools | Daemon-registered tools exposed into every run, Cedar-governed — governing amendments in-tree (B3 merged 2026-07-05; B20 merged via #175) — specs re-promoted `approved` 2026-07-18 (W1.5 gate cleared) |
| 22 | Execution postures and sandbox profiles | Per-run sandbox posture as an authorization input, provider-uniform presets — governing amendments in-tree (B20 merged via #175; B3 merged 2026-07-05) — specs re-promoted `approved` 2026-07-18 (W1.5 gate cleared) |
| 23 | Realtime voice channels | Reserved and capability-gated on upstream Codex realtime-flag stabilization — governing amendments in-tree (B6 landed 2026-07-06; B1 merged via #173) — specs re-promoted `approved` 2026-07-18 (W1.5 gate cleared) |

**V1.1 additions:** MLS relay E2EE and email invite delivery (cross-node shared artifacts moved into V1 per the ADR-015 amendment 2026-07-08), plus the criterion-gated sub-feature commitments named in ADR-015 (workflow BIND channel reuse; `human`-phase default timeout; automated GDPR erasure endpoint; direct-first artifact fetch).

---

## Build Order

Implementation follows the tiered dependency graph defined in [`docs/architecture/cross-plan-dependencies.md`](docs/architecture/cross-plan-dependencies.md). V1 spans 28 implementation plans (the 28th — [Plan-028](docs/plans/028-mcp-server-configuration-and-governance.md) for feature #18's MCP governance — landed 2026-07-22 via the campaign's B18 bundle at `draft`, promoted `review` 2026-08-12 by its targeted readiness audit — §6 node NS-61 — and `approved` 2026-08-14 by its §Rollout Order step-2 promotion; MCP-governance code dispatches in tier order per its §Preconditions); Plan-001 Shared Session Core is `completed` and the other 27 are `approved` — Plan-028 MCP Governance among them, promoted `draft → review` 2026-08-12 by its targeted readiness audit (§6 node NS-61, which authored its five audit-grade `#### Tasks` blocks and minted its effective-binding carrier box) and `review → approved` 2026-08-14 by its §Rollout Order step-2 promotion citing that audit's REVIEW.md, as is Plan-027 Cross-Node Dispatch — flipped 2026-07-19 for the campaign B17 pending-dispatch table and restored 2026-07-20 by its W2.5 targeted re-audit (#227). Plan-004 Queue Steer Pause Resume joined them 2026-07-20 — a standing `review` (never campaign-flipped) promoted by its W2.5 targeted re-audit (#228) after the campaign B9 rollback/park bundle, re-flipped `review` 2026-08-03 with Spec-004 by the V1 product-vision reconciliation, and restored `approved` 2026-08-08 by the cross-user run-control authorization targeted readiness-audit delta (#299 / NS-49) — the reconciliation batch's first restoration. Plan-005 Provider Driver Contract followed on the same 2026-07-20 — flipped that day for the campaign B10 driver-tasks bundle and restored by its W2.5 targeted re-audit (#229). Plan-016 Multi-Agent Channels joined them 2026-07-21 — flipped the same day by the campaign B15 orchestration bundle (mandatory T2.7 blocking-state sweep behavior + the I-016-14 two-exemption rewrite) and restored by its W2.5 targeted re-audit (#238), a joint spec+plan promotion with Spec-016. Plan-008 Control-Plane Relay joined them 2026-07-21 — a standing `review` (never campaign-flipped) promoted by its W2.5 targeted re-audit (#239) after the campaign B12 resume-and-subscribe consumer task. Plan-012 Approvals joined them 2026-07-21 — flipped 2026-07-20 by the campaign B13 spawn-env/normalizer/posture amendment (new invariants I-012-20..22), edited again by B15's mint-rule leg, and restored by its W2.5 targeted re-audit (#240) — then re-flipped `review` 2026-08-03 with Spec-012 by the V1 product-vision reconciliation, and restored `approved` 2026-08-10 by the cross-user run-control authorization targeted readiness-audit delta (#317 / NS-54), the reconciliation batch's second restoration. Plan-024 Rust PTY Sidecar joined them 2026-07-21 — flipped the same day by the campaign B16 Phase-3B PTY-substrate-hardening authoring (new phase, invariants I-024-7..12), restored by its W2.5 targeted re-audit (#241), re-flipped `review` 2026-08-02 by the CP-024-5 credential-seam registration (PR #279), and restored `approved` 2026-08-03 by the CP-024-5 targeted readiness-audit delta (#283 / NS-44). Plan-006 Session Event Taxonomy rejoined the `approved` set 2026-08-02 — re-flipped that day by the T3.1 ingest-halt seam amendment (#281), after its 2026-07-29 flip and 2026-08-01 #278 restore, and restored by the T3.1-seam targeted readiness-audit delta (#282 / NS-43). The 2026-08-03 V1 product-vision reconciliation (the [`docs/vision.md`](docs/vision.md) lock-in, PR #284) flipped Plans 002 / 003 / 004 / 008 / 012 / 016 and their paired specs back to `review` for its amendment bundle — cross-user intervention authority, typing presence plus the `ChannelList` non-disclosure filter, peer history backfill with per-channel relay recipient scoping, and channel audience plus `direct` channels among its legs — each restoring `approved` via its own queued targeted readiness-audit delta. Plan-004/Spec-004's delta — the cross-user intervention authority leg — landed 2026-08-08 (#299 / NS-49), restoring both, and Plan-012/Spec-012's — the remembered-grant actor-axis and turn-scoped effective-principal leg — landed 2026-08-10 (#317 / NS-54), restoring both, and Plan-016/Spec-016's — the channel-audience + `direct`-channels leg itself — landed 2026-08-11 (#321 / NS-56), restoring both and carrying beside the flipped growth the Spec-006 channel-lifecycle payload growth (the `channel.created` kind + member-pair mirror, the D-016-22 origin-ordering keys, and the run-interrupt trigger-union member) (Spec-006 flip-and-restored `approved` in the same swap), the D-016-22 channel-directory publication producer, and the D-016-23 Plan-017 provider legs, and Plan-002/Spec-002's — the typing-presence + `ChannelList` `direct`-filter leg — landed the same day (#322 / NS-57), restoring both and carrying beside the flipped growth the run-keyed `activity.runs` presence contract, the `invite.preview` + invite wire-error contract (BL-133 exit criteria (a)+(b); Spec-021 flip-and-restored `approved` in the same swap for its two anonymous invite registry rows, and Spec-016 flip-and-restored `approved` in the same swap for the channel-directory fold redesign + publication-shape growth its Codex round 1 drove — the per-origin candidate-retention fold and the wire-carried `lifecycleEventKind`), and the channel-directory ingest carrier (the `session_channel_directory` table + `channel.directoryPublish` mutation under I-002-7 / CP-002-10, completing BL-149 and checking Plan-016's carrier box), and Plan-008/Spec-008's — the peer-history-backfill + per-channel-recipient-scoping leg itself — landed 2026-08-11 (#323 / NS-58), restoring both and carrying beside the flipped growth the two mechanism legs its paired-spec box pinned — the Spec-006 received-row provenance amendment (the `session_events.received_from_node_id` marker column and the conditional `receivedFromNodeId` canonical member; Spec-006 and Plan-006 flip-and-restored `approved` in the same swap) and the admission-time signing-key registration decoupling (the never-shipped attachment-delivery machinery deleted doc-only — local SQLite census 56 → 55) — plus the R4 backfill task T-008r-4-14 with CP-008-13 and the audit of the PR #322-routed invite-leg growths, and Plan-003/Spec-003's — the dual-scope leg pairing that reconciliation growth with the BL-141 caller-authorization growth under the campaign's Dual-flip gate — landed 2026-08-12 (§6 node NS-60), restoring both and carrying ADR-025 `accepted`, Plan-003 tasks T3.10–T3.12, invariants I-003-3 (amended) and I-003-6 (new), and the Plan-008 I-008-4 gated-endpoint leg the #323 vehicle did not carry (Plan-008 flip-and-restored `approved` in that same swap) — the batch's sixth and last restoration, closing the cohort. Plan-010 Worktree Lifecycle, flipped 2026-07-19 for the campaign B22 turn-snapshot Phase and restored 2026-07-20 by its W2.5 targeted re-audit (#220), rejoined the `approved` set 2026-08-09 — re-flipped `review` that day with Spec-010 by the sparse-root capture-closure amendment (new Phase 6 / T6.1 / invariant I-010-24; #307) and restored the same day by its sparse-closure targeted readiness-audit delta (#308 / NS-51) — an amendment outside the 2026-08-03 reconciliation batch, so that batch's outstanding pairs are unchanged by it. It left the `approved` set again 2026-08-10 and rejoined it the same day: the boundary-obstruction refusal naming amendment — recording in I-010-24 and the Spec-010 capture bullet the typed pre-mutation refusal, the kind-scoped delete-exemption widths, and the byte-exact boundary subtraction that Phase 6's merged code (#309) already ships — re-flipped it and Spec-010 `review` under the Status Flip Rule's plan-body-behavior row, and its boundary-obstruction targeted readiness-audit delta (§6 node NS-53) restored both `approved`; that amendment likewise sits outside the 2026-08-03 reconciliation batch, whose outstanding pairs it leaves unchanged (the batch stood at four after that same day's Plan-012/Spec-012 restoration recorded above). Plan-013 Live Timeline and Plan-017 Workflow Authoring joined the `approved` set 2026-08-10 at the Tier-8 plan-readiness audit (NS-20, PR #318): Plan-013 — flipped 2026-07-20 by the campaign B9 CP-004-13 superseded-turn consumer amendment — restored `approved` with Spec-013, discharging the last campaign flip that was awaiting a restoring re-audit, and Plan-017 promoted `review → approved`, the final first-time plan promotion riding a tier audit, with Spec-017 and Plan-023 flip-and-restored `approved` in the same swap under their audit-amendment growths (the visual node-graph builder amendment — ADR-026 riding the audit PR at `proposed` — and Plan-023's four Status Flip Rule row-3 triggers). Plan-017 and Spec-017 left the `approved` set again 2026-08-11 and rejoined it the same day: the chat-start amendment ([ADR-027](docs/decisions/027-chat-invoked-workflow-start.md), landing `proposed` in the amendment PR, #319) adds the three chat-adjacent callers of `workflow.runStart` under `Spec-017 §Chat-Invoked Start and Start Authorization`, flipping both `review` scoped to that growth; unlike the Tier-8 flip-and-restore, the restoring targeted readiness-audit delta rides a separate PR (the PR #307 → #308 two-PR shape), and it landed the same day (#320 / NS-55), restoring both `approved` — an amendment outside the 2026-08-03 reconciliation batch, whose outstanding pairs it leaves unchanged. Plan-014 Artifacts rejoined the `approved` set 2026-08-12 — re-opened 2026-07-08 with Spec-014 for the cross-node relay scope growth (Tasks 7–10, the two `artifact_relay_*` Postgres tables, the upload/fetch wire surface) and restored by its relay-scope targeted readiness-audit delta (§6 node NS-59), which ratified the unowned envelope-interior application-payload discriminator as a Plan-008-owned registration seam (D-014-5 / CP-014-4 ⇄ CP-008-16, Plan-008 and Spec-008 both staying `approved`) and declared the Plan-018 fetch-token-issuer and Plan-003 node-selector edges; likewise an amendment outside the 2026-08-03 reconciliation batch, so that batch's then-outstanding pair is unchanged by it. Plan-025 Self-Hostable Node Relay rejoined the `approved` set 2026-08-15 — its NS-19 Tier-7 audit flip (2026-06-15, the audit's own Status Flip Rule consequence) discharged administratively via the runbook §Status Promotion Gate promotion (#333), the Plan-007 / Plan-022 / Plan-028 shape, citing the audit's 2026-06-19 completion and the `plan-readiness-audit-tier-7-complete` tag; promotion is status-gate clearance only — the Tier-7 remainder code still dispatches on tier order plus the plan's five unchecked §Preconditions boxes. Plan-018 Identity And Participant State rejoined the `approved` set 2026-08-15 — the last plan out of `review`, promoted by the NS-62 promotion pass (#334), which carries the targeted readiness-audit delta its post-audit obligations CP-018-12 / CP-018-13 scheduled: Phase 5 authored (T5.1–T5.8 — the daemon credential seam + participant identity-key roster, adding the `participant_identity_keys` table, Postgres 25 → 26), the client-side presenter carrier box born-unchecked, and Spec-018 + Plan-006 flip-and-restored `approved` in the same swap; the plan-promotion queue is now empty, and Tier-5 code still dispatches in tier order on the plan's §Preconditions.

```
Tier 1  ► Plan-001  Shared Session Core
         Plan-024  Rust PTY Sidecar
Tier 2  ► Plan-002  Invite, Membership, Presence
Tier 3  ► Plan-003  Runtime Node Attach
Tier 4  ► Plan-005  Provider Driver Contract
         Plan-006  Event Taxonomy and Audit Log
         Plan-007  Local IPC and Daemon Control
Tier 5  ► Plan-004  Queue, Steer, Pause, Resume
         Plan-008  Control Plane Relay
         Plan-018  Identity and Participant State
         Plan-022  Data Retention and GDPR
         Plan-025  Self-Hostable Node Relay (crypto package only)
Tier 6  ► Plan-009  Repo Attachment and Workspace Binding
         Plan-010  Worktree Lifecycle
         Plan-012  Approvals and Permissions
         Plan-016  Multi-Agent Channels
         Plan-021  Rate Limiting Policy
Tier 7  ► Plan-011  Git Flow, PR, Diff Attribution
         Plan-014  Artifacts, Files, Attachments
         Plan-015  Persistence, Recovery, Replay
         Plan-025  Self-Hostable Node Relay (remaining steps)
         Plan-028  MCP Server Configuration and Governance
Tier 8  ► Plan-013  Live Timeline and Visibility
         Plan-017  Workflow Authoring and Execution
         Plan-019  Notifications and Attention
         Plan-020  Observability and Failure Recovery
         Plan-023  Desktop Shell and Renderer
Tier 9  ► Plan-026  First-Run Three-Way-Choice Onboarding
         Plan-027  Cross-Node Dispatch and Approval
```

Each tier's prerequisites are the prior tier's completion. See [`docs/architecture/cross-plan-dependencies.md`](docs/architecture/cross-plan-dependencies.md) for the full dependency graph and table ownership map.

---

## Project Status

**Phase: Tier 2-4 code execution underway; plan-readiness audits complete through Tier 9 (NS-21, PR #331 — the tier-audit chain is closed) — except the re-opened Preconditions deltas: Plan-014's relay scope growth (the 2026-07-08 growth re-opened its checkbox; restored `approved` 2026-08-12 by its relay-scope targeted readiness-audit delta, §6 node NS-59, which re-checked both boxes and minted one born-unchecked scoped box at its Codex fold, the Task-8 fetch-selector daemon carrier — Tasks 7–10 now ride Tier-7 order rather than the delta (phase decomposition delivered 2026-08-15); that carrier box was **checked and discharged** 2026-08-16 by the four-leg artifact-lifecycle amendment and its in-swap targeted readiness-audit delta (§6 node NS-64), which re-specified the Task-8 selector as the caller's artifact-encryption key-thumbprint set — material the daemon already holds, so no carrier was needed — and added local Tasks 11–13 (OWASP ingest validation, `ArtifactDelete` + derived CAS refcount, typed attachment references), leaving Task 8's mint leg with no hold; Tasks 1–6 were covered throughout; the pair flipped and restored `approved` a third time 2026-08-17 by the ingest-protocol hardening amendment and its in-swap targeted readiness-audit delta (§6 node NS-70) — five Codex PR #341 round-5 findings hardened into the ingest stream protocol (retry-idempotent `AttachmentIngestComplete`, serialized reserve-then-install byte ledgers, per-`ingestId` single-flight with the reaper under the same exclusion, the `pinned` → `expired` fetch-path write-back grounding the unresolved-marker cause, and runnable admission probes), no census move, BL-152 minted for the flagged TTL-sweep disposition), the 2026-08-03 V1 product-vision reconciliation flips on Plans 002 / 003 / 004 / 008 / 012 / 016 — Plan-004 (with Spec-004) restored `approved` 2026-08-08 by its cross-user run-control authorization targeted readiness-audit delta (#299 / NS-49) and Plan-012 (with Spec-012) restored `approved` 2026-08-10 by that amendment's second leg (#317 / NS-54), and Plan-016 (with Spec-016) restored `approved` 2026-08-11 by its channel-directory targeted readiness-audit delta (#321 / NS-56), and Plan-002 (with Spec-002) restored `approved` 2026-08-11 by its membership + channel-directory targeted readiness-audit delta (#322 / NS-57), and Plan-008 (with Spec-008) restored `approved` 2026-08-11 by its relay + backfill targeted readiness-audit delta (#323 / NS-58), and Plan-003 (with Spec-003) restored `approved` 2026-08-12 by its dual-scope caller-authorization targeted readiness-audit delta (§6 node NS-60), which also lands [ADR-025](docs/decisions/025-runtime-node-control-plane-caller-authorization.md) `accepted` and the Plan-008 I-008-4 leg that plan's own vehicle did not carry (Plan-008 flip-and-restored `approved` in that same swap); all six pairs are restored and the cohort is closed — and the 2026-08-09 sparse-root capture-closure flip on Plan-010 (with Spec-010, PR #307), restored `approved` the same day by its sparse-closure targeted readiness-audit delta (#308 / NS-51), re-flipped `review` again 2026-08-10 with Spec-010 by the boundary-obstruction refusal naming amendment, and restored `approved` again the same day by its boundary-obstruction targeted readiness-audit delta (§6 node NS-53) — and the 2026-08-11 chat-start flip on Plan-017 (with Spec-017, per ADR-027; PR #319), restored `approved` the same day by its chat-start targeted readiness-audit delta (#320 / NS-55) — that pair then flip-and-restored `approved` again 2026-08-17 by the workflow-hardening amendment and its in-swap targeted readiness-audit delta (§6 node NS-68), and again 2026-08-18 by the park-surface and operator-controls amendment and its in-swap delta (§6 node NS-72), which closes the operator-reachability residual NS-68 recorded: the four park fields become additive-optional, live-scoped members of the phase-state projection and the `workflow.runCancel` / `workflow.runResume` operations mint together with the `workflow.cancelled` event, moving the workflow wire registry eleven → thirteen and the `workflow.*` event taxonomy 23 → 24 across five unchanged categories, with three refusal codes registered, [BL-151](docs/archive/backlog-archive.md) `completed`, and [ADR-026](docs/decisions/026-visual-node-graph-workflow-authoring.md) + [ADR-027](docs/decisions/027-chat-invoked-workflow-start.md) promoted `accepted` in the same swap — releasing the full-phase Gate-5 holds on Plan-017 Phases 1 and 5.**

Current documentation corpus:

- **28 V1 implementation plans** with step-by-step build instructions; 27 are `approved` (Plan-006 among them — re-flipped 2026-08-02 by its T3.1 ingest-halt seam amendment, #281, and restored the same day by the T3.1-seam targeted readiness-audit delta, #282; Plan-024 likewise — re-flipped 2026-08-02 by the CP-024-5 credential-seam registration, #279, and restored 2026-08-03 by the CP-024-5 targeted readiness-audit delta, #283 / NS-44; Plan-004 rejoined them 2026-08-08 — re-flipped 2026-08-03 with Spec-004 by the V1 product-vision reconciliation and restored by the cross-user run-control authorization targeted readiness-audit delta, #299 / NS-49; and Plan-010 has been among them since 2026-08-09 — re-flipped that day with Spec-010 by the sparse-root capture-closure amendment (new Phase 6 / T6.1 / invariant I-010-24; #307) and restored by its sparse-closure targeted readiness-audit delta, #308 / NS-51, then re-flipped 2026-08-10 by the boundary-obstruction refusal naming amendment, which records in I-010-24 and the Spec-010 capture bullet the typed pre-mutation obstruction refusal, the kind-scoped delete-exemption widths, and the byte-exact boundary subtraction that Phase 6's merged code (#309) already ships, and restored `approved` the same day by that amendment's own boundary-obstruction targeted readiness-audit delta, §6 node NS-53; and Plan-012 rejoined them 2026-08-10 — re-flipped 2026-08-03 with Spec-012 by the V1 product-vision reconciliation and restored by the cross-user run-control authorization targeted readiness-audit delta, #317 / NS-54; and Plan-013 + Plan-017 joined them 2026-08-10 at the Tier-8 plan-readiness audit, NS-20 / PR #318 — Plan-013 restored `review → approved` with Spec-013, discharging its 2026-07-20 campaign B9 CP-004-13 superseded-turn consumer flip, and Plan-017 promoted `review → approved`, the final first-time plan promotion riding a tier audit, with Plan-023 flip-and-restored `approved` in the same swap; Plan-017 then re-flipped `review` 2026-08-11 with Spec-017 by the chat-start amendment (ADR-027; PR #319) and was restored `approved` the same day by its chat-start targeted readiness-audit delta, #320 / NS-55; and Plan-016 rejoined them 2026-08-11 — re-flipped 2026-08-03 with Spec-016 by the V1 product-vision reconciliation and restored by its channel-directory targeted readiness-audit delta, #321 / NS-56, which also landed the D-016-22 channel-directory publication producer and the D-016-23 Plan-017 provider legs — `ChannelConfig.turnsPerAgent` plus the fourth `InterruptReason` member `workflow_phase_cancelled` — discharging Plan-017's A-017-07; and Plan-002 rejoined them 2026-08-11 — re-flipped 2026-08-03 with Spec-002 by the V1 product-vision reconciliation and restored by its membership + channel-directory targeted readiness-audit delta, #322 / NS-57, which also landed the run-keyed `activity.runs` presence contract, the `invite.preview` + invite wire-error contract (BL-133 exit criteria (a)+(b)), and the channel-directory ingest carrier — the `session_channel_directory` table and the `channel.directoryPublish` mutation under invariant I-002-7 / obligation CP-002-10 — completing BL-149 and checking Plan-016's §Preconditions carrier box; and Plan-008 rejoined them 2026-08-11 — re-flipped 2026-08-03 with Spec-008 by the V1 product-vision reconciliation and restored by its relay + backfill targeted readiness-audit delta, #323 / NS-58, which also authored the R4 backfill task T-008r-4-14 with obligation CP-008-13, landed the Spec-006 received-row provenance amendment (Spec-006 and Plan-006 flip-and-restored `approved` in the same swap) and the admission-time signing-key registration decoupling, and audited the PR #322-routed invite-leg growths; and Plan-014 rejoined them 2026-08-12 — re-opened 2026-07-08 with Spec-014 by the cross-node relay scope growth and restored by its relay-scope targeted readiness-audit delta, §6 node NS-59, which ratified the envelope-interior application-payload discriminator as a Plan-008-owned registration seam, D-014-5 / CP-014-4 ⇄ CP-008-16, with Plan-008 and Spec-008 both staying `approved`; and Plan-003 rejoined them 2026-08-12 — re-flipped 2026-08-03 with Spec-003 by the V1 product-vision reconciliation and restored by its dual-scope caller-authorization targeted readiness-audit delta, §6 node NS-60, which covers that reconciliation growth and the BL-141 caller-authorization growth in one vehicle under the campaign's Dual-flip gate, lands ADR-025 `accepted` with Plan-003 tasks T3.10–T3.12 plus invariants I-003-3 (amended) and I-003-6 (new), and folds in the Plan-008 I-008-4 gated-endpoint leg the #323 vehicle did not carry, with Plan-008 flip-and-restored `approved` in the same swap — closing the 2026-08-03 reconciliation cohort, whose six pairs are now all restored; and Plan-028 joined them 2026-08-14 — feature #18's MCP governance, landed 2026-07-22 via campaign B18 at `draft`, promoted `review` 2026-08-12 by its targeted readiness audit, §6 node NS-61, which authored its five audit-grade `#### Tasks` blocks, and `approved` 2026-08-14 by its §Rollout Order step-2 promotion citing that audit's REVIEW.md; and Plan-025 rejoined them 2026-08-15 — its NS-19 Tier-7 audit flip discharged administratively via the runbook §Status Promotion Gate promotion, #333, citing the audit's 2026-06-19 completion and the `plan-readiness-audit-tier-7-complete` tag, with PR #160's body as the Tier-7 REVIEW.md record; and Plan-018 joined them 2026-08-15 — the last plan out of `review`, flipped there at its 2026-05-30 Tier-5 plan-readiness audit and promoted by the NS-62 promotion pass, #334, which carries the targeted readiness-audit delta its post-audit obligations CP-018-12 / CP-018-13 scheduled — authoring Phase 5 (T5.1–T5.8, the daemon credential seam + participant identity-key roster), minting the client-side presenter carrier box, flip-and-restoring Spec-018 and Plan-006 in the same swap, and adding the `participant_identity_keys` table, Postgres 25 → 26), Plan-001 is `completed`, and none are in `review` — the plan-promotion queue is empty
- **28 specifications** covering every feature and cross-cutting concern (28 `approved` — including four of the nine W1-amended specs still holding their 2026-07-18 re-promotion via the campaign's W1.5 batch gate (Task 28): Spec-005/006/015/024, with Spec-010 the fifth W1.5 re-promotion (re-flipped `review` 2026-08-09 by the sparse-root capture-closure amendment, PR #307, restored `approved` the same day by its sparse-closure targeted readiness-audit delta, #308 / NS-51, then re-flipped 2026-08-10 with Plan-010 by the boundary-obstruction refusal naming amendment and restored `approved` the same day by its boundary-obstruction targeted readiness-audit delta, §6 node NS-53) — Spec-006 re-flipped `review` 2026-07-22 by the campaign B18 census amendment, restored `approved` the same day by its named follow-on re-promotion, and flip-and-restored `approved` again 2026-08-11 in the Spec-016 channel-directory delta's same swap for its channel-lifecycle payload growth (the `channel.created` kind + member-pair mirror, the D-016-22 origin-ordering keys, and the run-interrupt trigger-union member) (#321 / NS-56), Spec-028 landed at `review` 2026-07-22 and promoted `approved` the same day via the campaign's W3 gate, and Spec-004 rejoined 2026-08-08 — flipped 2026-08-03 by the V1 product-vision reconciliation and restored by its cross-user run-control authorization targeted readiness-audit delta, #299 / NS-49, with Spec-012 rejoining 2026-08-10 by the same amendment's second leg — the remembered-grant actor-axis and turn-scoped effective-principal delta, #317 / NS-54, and with Spec-013 rejoining 2026-08-10 — flipped 2026-07-20 by the campaign B9 CP-004-13 superseded-turn consumer amendment and restored `approved` by the Tier-8 plan-readiness audit (NS-20 / PR #318), which also flip-and-restored Spec-017 `approved` in the same swap by the visual-builder amendment — Spec-017 then re-flipped `review` 2026-08-11 by the chat-start amendment (ADR-027 / PR #319) and was restored `approved` the same day by its chat-start targeted readiness-audit delta, #320 / NS-55, and with Spec-016 rejoining 2026-08-11 — flipped 2026-08-03 by the reconciliation bundle and restored by its channel-directory targeted readiness-audit delta, #321 / NS-56, and with Spec-002 rejoining 2026-08-11 — flipped 2026-08-03 by the reconciliation bundle and restored by its membership + channel-directory targeted readiness-audit delta, #322 / NS-57, with Spec-021 flip-and-restored `approved` in the same swap for its `invite.preview` + stacked `invite.redeem_ip` registry rows (24 → 25) and Spec-016 flip-and-restored `approved` in the same swap for the channel-directory fold redesign + publication-shape growth (PR #322 Codex round 1), and with Spec-008 rejoining 2026-08-11 — flipped 2026-08-03 by the reconciliation bundle and restored by its relay + backfill targeted readiness-audit delta, #323 / NS-58, with Spec-006 flip-and-restored `approved` in the same swap for its received-row provenance amendment (the conditional `receivedFromNodeId` canonical member and the Plan-008-owned `session_events.received_from_node_id` marker column), and with Spec-014 rejoining 2026-08-12 — re-opened 2026-07-08 for the cross-node artifact relay design and restored by the Plan-014 relay-scope targeted readiness-audit delta, §6 node NS-59, in the same swap as its paired plan, and with Spec-003 rejoining 2026-08-12 — flipped 2026-08-03 by the reconciliation bundle and restored by its dual-scope caller-authorization targeted readiness-audit delta, §6 node NS-60, which lands ADR-025 `accepted` and amends Spec-003 with **zero net line change** (174 lines before and after, so none of Plan-003's `Spec-003 line NNN` coverage cites moved), closing the reconciliation cohort's sixth and last pair, and with Spec-018 flip-and-restored `approved` 2026-08-15 in the Plan-018 NS-62 promotion pass's same swap (#334) for its participant identity-key roster + daemon-credential required-behavior growth — the Phase-5 decomposition's paired-spec half: register-once / refuse-on-rotation per ADR-021's control-plane half, membership-gated non-oracular roster reads, and the daemon-credential issuance seam; no spec is now in `review`, the seven restorations above carrying the other four W1-amended re-promotions among them; Spec-016's earlier 2026-07-21 B15 flip was restored the same day by Plan-016's W2.5 targeted re-audit, a joint spec+plan promotion) — the six campaign features' doc gates are closed (campaign plan `completed` 2026-08-15): feature #18's Spec-028 + Plan-028 landed 2026-07-22 via the B18 bundle, and features #19–#23's governing spec amendments are in-tree (B1 merged via #173, B3 merged 2026-07-05, B20 merged via #175, B6 landed 2026-07-06, B2 merged via #205; re-promoted via the W1.5 batch gate 2026-07-18; Spec-016 — the #20/#23 orchestration surface — was re-flipped `review` 2026-07-21 by B15's §Stop Conditions amendment, restored `approved` the same day by Plan-016's W2.5 targeted re-audit, then re-flipped `review` again 2026-08-03 alongside Spec-004 (#19) and Spec-012 (#21/#22) by the V1 product-vision reconciliation bundle per the `review` clause earlier in this bullet, re-opening the spec-layer gate on those three pending their targeted readiness-audit deltas — Spec-004's landed 2026-08-08 (#299 / NS-49), closing #19's spec layer again, and Spec-012's landed 2026-08-10 (#317 / NS-54), closing #21's and #22's, and Spec-016's landed 2026-08-11 (#321 / NS-56), closing #20's and #23's, so the spec-layer gate is closed across all of #19–#23), so implementation of #18 is doc-ungated — Plan-028 promoted `approved` 2026-08-14 via its §Rollout Order step-2 promotion, its targeted readiness audit having cleared 2026-08-12 (§6 node NS-61), with code dispatching in tier order on the plan's §Preconditions — and #19–#23's W2 plan-task bundles are all in-tree (campaign plan closed `completed` 2026-08-15), their implementation dispatching with the owning plans' code phases in tier order — plus one corpus-side gate, met 2026-08-10: #19's superseded-turn timeline rendering also rides the Spec-013/Plan-013 CP-004-13 consumer leg (both flipped `review` 2026-07-20; restored `approved` by the Tier-8 plan-readiness audit, NS-20)
- **12 domain models** (run state machine, intervention model, participant model, workflow model, etc.)
- **16 architecture documents** (schemas, contracts, security, deployment, dependencies)
- **11 operations runbooks** (CLI commands, SLOs, on-call routing, self-host secure defaults)
- **26 accepted ADRs** recording key design decisions (ADR-013 reserved-skipped; no ADR is now `proposed`) — ADR-025 (runtime-node control-plane caller authorization) landed `accepted` 2026-08-12, filling the reserved `025` gap, and ADR-026 (visual node-graph workflow authoring) + ADR-027 (chat-invoked workflow start) were promoted `proposed → accepted` 2026-08-18 by the Spec-017/Plan-017 park-surface + operator-controls amendment (§6 node NS-72), which also checked the two born-unchecked Plan-017 §Preconditions boxes those promotions gated — releasing the full-phase Gate-5 holds on Plan-017 Phases 1 and 5

---

## Documentation

| Area | Path | Description |
| --- | --- | --- |
| Vision | [`docs/vision.md`](docs/vision.md) | Product thesis and architectural position |
| Specs | [`docs/specs/`](docs/specs/) | Feature specifications (001-027) |
| Plans | [`docs/plans/`](docs/plans/) | Implementation plans (001-027) |
| Architecture | [`docs/architecture/`](docs/architecture/) | Schemas, contracts, security, deployment |
| Domain Models | [`docs/domain/`](docs/domain/) | State machines, glossary, entity models |
| ADRs | [`docs/decisions/`](docs/decisions/) | Architectural decision records |
| Operations | [`docs/operations/`](docs/operations/) | Runbooks, SLOs, on-call routing |
| V1 Scope | [`docs/architecture/v1-feature-scope.md`](docs/architecture/v1-feature-scope.md) | What ships in V1 vs V2 |
| Build Order | [`docs/architecture/cross-plan-dependencies.md`](docs/architecture/cross-plan-dependencies.md) | 9-tier implementation sequence |
| Contributing | [`CONTRIBUTING.md`](CONTRIBUTING.md) | Branch naming, commit format, PR workflow |

---

## License

AI Sidekicks is licensed under the [Apache License, Version 2.0](./LICENSE) — see [ADR-020](docs/decisions/020-v1-deployment-model-and-oss-license.md) for the deployment-model and license commitment.
