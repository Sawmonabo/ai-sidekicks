# Reference Library Index

This directory contains the complete analysis of three reference applications (Forge, CodexMonitor, Paseo) and audits of the ai-sidekicks design documentation. Use this index to find relevant information when implementing backlog items.

## How to Use

1. **Working on a backlog item?** Jump to [Backlog Item Reference Map](#backlog-item-reference-map) for direct file pointers.
2. **Researching a topic across apps?** Jump to [Topic Cross-Reference](#topic-cross-reference) for per-app section links.
3. **Need to know what's in a file?** Jump to [File Manifest](#file-manifest) for one-line descriptions of every file.

---

## File Manifest

### Forge (`forge/`)

| File | Content |
|---|---|
| `forge/review.md` | Tech stack (Effect, SQLite, Electron), architecture (command/event, projections), full feature inventory, signature feature analysis vs ai-sidekicks, provider driver model (Codex + Claude adapters), persistence (34 migrations, event store), real-time visibility, collaboration model, gaps. Appendix A: complete user-facing feature audit with per-feature evidence trails. |
| `forge/server.md` | Server source-code inventory: 20 directory sections, 50+ RPC methods, WebSocket + HTTP API surface, orchestration engine internals, provider architecture (CodexAdapter, ClaudeAdapter), full persistence layer (34 migrations, every table), daemon mode, terminal service, git operations, design mode, checkpointing. |
| `forge/frontend.md` | Frontend source-code inventory: 90+ components, route map, session logic pipeline (orchestration events → state → timeline), composer system, diff panel, workflow editor, discussion editor, design preview, sidebar data flow, state stores. |
| `forge/contracts-desktop.md` | Shared contracts inventory: 27 base + 42 extended event types (69 total), 20 branded entity IDs, workflow types (4 phase types, gate types, quality checks), discussion types, interactive request types, IPC bridge (22 Electron channels), desktop shell (Electron main process, WSL, auto-updater). |

### CodexMonitor (`codexmonitor/`)

| File | Content |
|---|---|
| `codexmonitor/review.md` | Tech stack (Tauri/Rust + React), architecture (Tauri commands → Codex core → JSON-RPC), full feature inventory, signature feature analysis, Codex integration model (app-server wrapping), state management, multi-agent model, remote/daemon architecture, gaps. Appendix A: complete user-facing feature audit with per-feature evidence trails. |
| `codexmonitor/backend.md` | Backend source-code inventory: Tauri commands (122 total), Codex JSON-RPC integration (20 methods, 29 server notifications), remote/daemon TCP mode, git operations (20+ commands), agent config management, file system operations, prompt library, settings persistence, terminal backend. |
| `codexmonitor/frontend.md` | Frontend source-code inventory: 200 source files, ~100 hooks, ~80 components, 7 message item types, 14 Zustand stores, composer system (slash commands, autocomplete, queue/steer), workspace/thread navigation, git UI, settings (13 sections), file browser, prompt library UI. |

### Paseo (`paseo/`)

| File | Content |
|---|---|
| `paseo/review.md` | Tech stack (Node, Expo, React), architecture (daemon + multi-client), full feature inventory, signature feature analysis, provider normalization (5 providers: Claude, Codex, OpenCode, Copilot, Pi), persistence (file-backed JSON), real-time visibility, security (Curve25519 E2E encryption), automation (schedules, loops, skills), gaps. |
| `paseo/server.md` | Server source-code inventory: 370 source files, daemon lifecycle, WebSocket protocol, provider architecture (5 builtin + ACP), agent manager, chat service, automation services (schedules, loops, speech), MCP integration (30 tools), terminal, git/workspace, persistence model, security, speech/audio pipeline. |
| `paseo/app-cli.md` | App + CLI source-code inventory: 530 source files, Expo React app (14 Zustand stores, route model, stream normalization), 60+ CLI subcommands, draft-agent form resolution, file/workspace navigation, settings/diagnostics. |
| `paseo/desktop-relay.md` | Desktop + relay + infrastructure inventory: Electron shell, Curve25519 ECDH + NaCl encryption, Cloudflare Durable Objects relay, 6 skills (code, shell, web, docs, image, mcp), 8-package monorepo structure, website. |
| `paseo/implementation-details/` | 10-file deep implementation walkthrough: server daemon internals, app client architecture, CLI/desktop, relay/support packages, server services (file-backed persistence, loops, schedules, speech, terminals), provider normalization (adapter signatures, wrapSessionProvider), app state/UI/routing, session/agent manager (role split, timeline projection, attention), provider transports (per-provider specifics: Claude spawn hooks, Codex JSON-RPC, OpenCode singleton, ACP stdio). |

### Analysis

| File | Content |
|---|---|
| `backlog-reference-analysis.md` | Complete per-backlog-item analysis with reference app evidence, web research, and final recommendations for all 37 backlog items. Includes technology decisions table and compatibility resolution log. |

### Design Audits (`design-audits/`)

| File | Content |
|---|---|
| `design-audits/session-collaboration.md` | Audit of specs 001, 002, 003, 008, 015, 016, 018, 019 and plans 001, 002, 003, 015, 016, 018. Covers session model, invites, membership, presence, channels, multi-agent orchestration, notifications. Identifies 6 critical gaps. |
| `design-audits/runtime-execution.md` | Audit of specs 004, 005, 006, plans 004, 005, 006, run state machine, queue/intervention model. Covers run lifecycle, provider drivers, queue/steer/pause, event taxonomy. Identifies state machine gaps, spec contradictions, driver contract issues. |
| `design-audits/git-workflow.md` | Audit of specs 009, 010, 011, 012, 014, 017, plans 009, 011, 012, 014, 017, domain models, ADRs 004/006. Covers repo/workspace/worktree, git flow, diff attribution, PR prep, workflow authoring, approval model. Identifies workflow spec weakness as largest gap area. |
| `design-audits/architecture-ops.md` | Audit of 9 architecture docs, 4 specs, 4 plans, glossary, 8 operations runbooks. Covers C4 architecture, data architecture, IPC/transport, event taxonomy, visibility/timeline, security, operations readiness, deployment topology, notifications. Identifies no schemas, no wire format, no auth mechanism as top 3 gaps. |

---

## Topic Cross-Reference

### Provider / Driver Model

| App | Reference |
|---|---|
| **Forge** | [review.md §5 Provider Driver Model](forge/review.md#5-provider-driver-model) — Effect-based adapter pattern, Codex + Claude drivers, capability flags, runtime event normalization |
| | [server.md §6 Provider Architecture](forge/server.md#6-provider-architecture) — CodexAdapter, ClaudeAdapter, provider session directory, event NDJSON logging |
| **CodexMonitor** | [review.md §5 Codex Integration Model](codexmonitor/review.md#5-codex-integration-model) — JSON-RPC wrapper around codex app-server, local + remote modes |
| | [backend.md §5 Codex Integration](codexmonitor/backend.md#5-codex-integration) — 20 JSON-RPC methods, 29 server notifications, event handling |
| **Paseo** | [review.md §5 Provider Normalization Model](paseo/review.md#5-provider-normalization-model) — 5 providers behind unified contract, deepest normalization of any reference app |
| | [implementation-details/06](paseo/implementation-details/06-server-providers-and-normalization.md) — adapter client signatures, wrapSessionProvider mechanics |
| | [implementation-details/09](paseo/implementation-details/09-provider-transports-and-features.md) — per-provider transport specifics (Claude CLI, Codex JSON-RPC, OpenCode, ACP stdio) |
| **Our docs** | [design-audits/runtime-execution.md §3](design-audits/runtime-execution.md#3-provider-driver-contract) — Spec-005 contradiction, missing pauseRun/steerRun |

### Run State Machine / Lifecycle

| App | Reference |
|---|---|
| **Forge** | [review.md §3.2 Session Lifecycle](forge/review.md#32-session-lifecycle) — 7 statuses, 10 session commands, turn lifecycle events |
| | [server.md §12 Session Types and Lifecycle](forge/server.md#12-session-types-and-lifecycle) — session types, decider logic, state transitions |
| **CodexMonitor** | [review.md §4.2 Queue Steer Pause Resume](codexmonitor/review.md#42-queue-steer-pause-resume) — stop vs pause vs resume behavioral analysis |
| | [review.md Appendix A.2](codexmonitor/review.md#a2-queue-steer-stop-pause-resume-and-multi-agent-semantics) — detailed behavioral normalization |
| **Paseo** | [review.md §4.2](paseo/review.md#42-queue-steer-pause-resume) — provider-level pause/resume, no formal run state machine |
| | [implementation-details/08](paseo/implementation-details/08-session-and-agent-manager.md) — agent run orchestration, replaceAgentRun stale-run prevention |
| **Our docs** | [design-audits/runtime-execution.md §2](design-audits/runtime-execution.md#2-run-state-machine-analysis) — missing transitions, gap analysis |

### Queue / Steer / Pause / Resume

| App | Reference |
|---|---|
| **Forge** | [review.md §4.2](forge/review.md#42-queue-steer-pause-resume) — daemon-side queue via orchestration commands |
| | [server.md §5 Orchestration Engine](forge/server.md#5-orchestration-engine) — command queue, serialized processing |
| **CodexMonitor** | [review.md Appendix A.2](codexmonitor/review.md#a2-queue-steer-stop-pause-resume-and-multi-agent-semantics) — CRITICAL: queue is client-side in-memory only, pause is queue-drain only, resume is thread refresh |
| **Paseo** | [review.md §4.2](paseo/review.md#42-queue-steer-pause-resume) — no formal queue, provider-level interrupt |
| **Our docs** | [design-audits/runtime-execution.md §4](design-audits/runtime-execution.md#4-queueintervention-model) — intervention state divergence |

### Session Model / Events

| App | Reference |
|---|---|
| **Forge** | [review.md §3.1 Orchestration Engine](forge/review.md#31-orchestration-engine) — command/event architecture, aggregate kinds, projection pipeline |
| | [server.md §5](forge/server.md#5-orchestration-engine) — OrchestrationEngine internals, event store, command receipts |
| | [contracts-desktop.md](forge/contracts-desktop.md) — 69 event types, 20 branded entity IDs |
| **CodexMonitor** | [review.md §6 State Management](codexmonitor/review.md#6-state-management-and-persistence) — Tauri-backed state, Zustand stores |
| **Paseo** | [review.md §6 Persistence and Data Model](paseo/review.md#6-persistence-and-data-model) — file-backed JSON, no event sourcing |
| | [implementation-details/08](paseo/implementation-details/08-session-and-agent-manager.md) — session controller, timeline with epoch/sequence/cursor |
| **Our docs** | [design-audits/session-collaboration.md](design-audits/session-collaboration.md) — session spec completeness, 6 critical gaps |
| | [design-audits/architecture-ops.md §4](design-audits/architecture-ops.md#4-event-taxonomy) — event envelope fields, missing type definitions |

### Invites / Membership / Presence

| App | Reference |
|---|---|
| **Forge** | [review.md §8 Collaboration Model](forge/review.md#8-collaboration-model) — ABSENT: no multi-user, no invites, no shared sessions |
| **CodexMonitor** | [review.md §4.1 Mid-Session Invites](codexmonitor/review.md#41-mid-session-invites-and-shared-runtime-contribution) — ABSENT: single-user only |
| **Paseo** | [review.md §4.1](paseo/review.md#41-mid-session-invites-and-shared-runtime-contribution) — ABSENT: no user identity system |
| **Our docs** | [design-audits/session-collaboration.md §6](design-audits/session-collaboration.md#6-critical-gaps) — invite delivery mechanism unspecified, presence heartbeat undefined |

### Channels / Multi-Agent Orchestration

| App | Reference |
|---|---|
| **Forge** | [review.md §3.4 Channel System](forge/review.md#34-channel-system) — 4 channel types, deliberation engine with stall detection |
| | [review.md §3.5 Discussion System](forge/review.md#35-discussion-system) — multi-participant discussions, MCP-based message relay |
| **CodexMonitor** | [review.md §7 Multi-Agent Model](codexmonitor/review.md#7-multi-agent-and-orchestration-model) — subagent visualization, no custom orchestration |
| | [review.md Appendix A.2.4](codexmonitor/review.md#a24-multi-agent-support) — detailed multi-agent behavioral analysis |
| **Paseo** | [review.md §3 Feature Inventory](paseo/review.md#3-complete-feature-inventory) — multi-agent via provider delegation |
| | [server.md §6 Agent Manager](paseo/server.md#6-agent-manager) — per-client session controller, shared agent runtime |
| **Our docs** | [design-audits/session-collaboration.md](design-audits/session-collaboration.md) — channel spec completeness |

### Repo / Workspace / Worktree / Git Flow

| App | Reference |
|---|---|
| **Forge** | [review.md §3.8 Git Integration](forge/review.md#38-git-integration) — core operations, GitHub CLI, text generation, worktree management, diff attribution |
| | [review.md Appendix A.4](forge/review.md#a4-git-worktrees-diffs-design-and-project-scripts) — user-facing git features with evidence |
| | [server.md §13 Git Operations](forge/server.md#13-git-operations) — GitCore, GitManager, GitHubCli implementation |
| **CodexMonitor** | [review.md §4.4 Repo Attach and Git Flow](codexmonitor/review.md#44-repo-attach-and-git-flow) — full git + worktrees, no diff attribution |
| | [review.md Appendix A.5](codexmonitor/review.md#a5-git-github-and-review-workflows) — detailed git/GitHub/review capabilities |
| **Paseo** | [review.md §4.4](paseo/review.md#44-repo-attach-and-git-flow) — init-only, weakest git of any reference app |
| | [server.md §11 Git/Workspace Service](paseo/server.md#11-gitworkspace-service) — workspace registry, git init |
| **Our docs** | [design-audits/git-workflow.md](design-audits/git-workflow.md) — repo/workspace/worktree model, diff attribution, PR prep, 6 Forge features not in specs |

### Diff Attribution / PR Preparation

| App | Reference |
|---|---|
| **Forge** | [review.md §3.8](forge/review.md#38-git-integration) — per-turn agent diffs, source classification, coverage levels |
| | [review.md Appendix A.4](forge/review.md#a4-git-worktrees-diffs-design-and-project-scripts) — diff modes, diff fallbacks, route-addressable diff state |
| | [contracts-desktop.md](forge/contracts-desktop.md) — agent diff event types |
| **CodexMonitor** | No diff attribution (workspace snapshots only) |
| **Paseo** | No diff attribution |
| **Our docs** | [design-audits/git-workflow.md §3](design-audits/git-workflow.md#3-git-flow-and-diff-attribution-assessment) — attribution modes, PR preparation contracts |

### Approval / Trust / Permissions

| App | Reference |
|---|---|
| **Forge** | [review.md §3.6 Interactive Request System](forge/review.md#36-interactive-request-system) — 8 request types, approval/permission/MCP elicitation flows |
| | [review.md Appendix A.2](forge/review.md#a2-chat-composer-and-session-runtime) — permission-request UX, pending approval UX |
| **CodexMonitor** | [review.md Appendix A.4.5](codexmonitor/review.md#a45-plans-and-approvals) — toast-based approval stack, remembered approval prefixes |
| **Paseo** | [review.md §8 Security and Remote Access](paseo/review.md#8-security-and-remote-access) — permission handling state machines |
| | [implementation-details/08](paseo/implementation-details/08-session-and-agent-manager.md) — permission-handling: buffered vs immediate response |
| **Our docs** | [design-audits/git-workflow.md §5](design-audits/git-workflow.md#5-approval-and-trust-model-assessment) — 4 authorization layers, remembered grants |
| | [design-audits/architecture-ops.md §6](design-audits/architecture-ops.md#6-security-architecture) — no auth mechanism, no token model |

### Visibility / Timeline / Reasoning Surfaces

| App | Reference |
|---|---|
| **Forge** | [review.md §7 Real-Time and Visibility](forge/review.md#7-real-time-and-visibility-architecture) — orchestration event streaming, timeline projection |
| | [frontend.md](forge/frontend.md) — MessagesTimeline, session-logic pipeline, background task tray |
| **CodexMonitor** | [review.md §4.5 Visibility](codexmonitor/review.md#45-visibility-into-agent-work) — message/tool rendering, no state timeline |
| | [frontend.md](codexmonitor/frontend.md) — message render utils, 7 item types |
| **Paseo** | [review.md §7 Real-Time and Visibility](paseo/review.md#7-real-time-and-visibility-architecture) — stream normalization, timeline rendering |
| | [implementation-details/07](paseo/implementation-details/07-app-state-ui-and-routing.md) — stream-normalization rules, gap detection |
| **Our docs** | [design-audits/architecture-ops.md §5](design-audits/architecture-ops.md#5-visibilitytimeline-spec) — timeline entry type coverage, handoff gap |

### Workflow Authoring and Execution

| App | Reference |
|---|---|
| **Forge** | [review.md §3.3 Workflow Engine](forge/review.md#33-workflow-engine) — 4 phase types, gates, quality checks, deliberation config, output modes |
| | [review.md Appendix A.3](forge/review.md#a3-workflows-discussions-plans-and-human-gates) — user-facing workflow/discussion/plan features |
| | [contracts-desktop.md](forge/contracts-desktop.md) — workflow types, phase types, gate types |
| **CodexMonitor** | No workflow system |
| **Paseo** | [review.md §9 Automation Features](paseo/review.md#9-automation-features) — skills (6 types), schedules, loops — different paradigm from workflows |
| | [server.md §8 Automation Services](paseo/server.md#8-automation-services) — schedule/loop/skill implementation |
| **Our docs** | [design-audits/git-workflow.md §4](design-audits/git-workflow.md#4-workflow-model-assessment) — workflow spec is weakest area, 4 Forge features missing from specs |

### Artifacts

| App | Reference |
|---|---|
| **Forge** | [review.md §3.9 Design Mode](forge/review.md#39-design-mode) — HTML artifacts, sandboxed iframe, screenshot service |
| | [server.md §14 Design Mode](forge/server.md#14-design-mode) — artifact storage, design MCP server |
| **CodexMonitor** | No artifact system |
| **Paseo** | No formal artifact system |
| **Our docs** | [design-audits/architecture-ops.md §2](design-audits/architecture-ops.md#2-data-architecture) — artifact storage mechanism unspecified |

### Notifications / Attention

| App | Reference |
|---|---|
| **Forge** | [server.md §8 Daemon Mode](forge/server.md#8-daemon-mode) — notification reactor, desktop notifications with deep links |
| **CodexMonitor** | [review.md Appendix A.8.3](codexmonitor/review.md#a83-notifications-and-platform-behavior) — system notifications for long-running runs |
| **Paseo** | [implementation-details/08](paseo/implementation-details/08-session-and-agent-manager.md) — attention persistence and archiving |
| **Our docs** | [design-audits/architecture-ops.md §9](design-audits/architecture-ops.md#9-notifications-model) — attention model well-specified, delivery mechanism gap |

### IPC / Transport / RPC

| App | Reference |
|---|---|
| **Forge** | [review.md §1 Technology Stack](forge/review.md#1-technology-stack) — Effect RPC over WebSocket |
| | [server.md §3 WebSocket API](forge/server.md#3-websocket-api-surface-wsts) — full WS API surface (50+ methods) |
| **CodexMonitor** | [backend.md §5 Codex Integration](codexmonitor/backend.md#5-codex-integration) — newline-delimited JSON-RPC over stdio |
| | [review.md §8 Remote/Daemon Architecture](codexmonitor/review.md#8-remotedaemon-architecture) — TCP with token auth |
| **Paseo** | [server.md §4 WebSocket Protocol](paseo/server.md#4-websocket-protocol) — WebSocket with ~90+ message types |
| | [desktop-relay.md](paseo/desktop-relay.md) — Cloudflare Durable Objects relay, E2E encryption |
| **Our docs** | [design-audits/architecture-ops.md §3](design-audits/architecture-ops.md#3-ipc-and-transport) — no wire format, no WebSocket mention, control-plane transport unspecified |

### Persistence / Database / Event Store

| App | Reference |
|---|---|
| **Forge** | [review.md §6 Persistence and State Model](forge/review.md#6-persistence-and-state-model) — SQLite WAL, event store, projections |
| | [server.md §7 Persistence Layer](forge/server.md#7-persistence-layer) — 34 migrations, every table defined |
| **CodexMonitor** | [review.md §6 State Management](codexmonitor/review.md#6-state-management-and-persistence) — Tauri-backed local state, no event sourcing |
| | [backend.md §11 Settings Persistence](codexmonitor/backend.md#11-settings-persistence) — app settings store |
| **Paseo** | [review.md §6 Persistence and Data Model](paseo/review.md#6-persistence-and-data-model) — file-backed JSON per session |
| | [server.md §12 Persistence Model](paseo/server.md#12-persistence-model) — file storage patterns |
| | [implementation-details/05](paseo/implementation-details/05-server-services-and-config.md) — FileBackedChatService, atomic writes |
| **Our docs** | [design-audits/architecture-ops.md §2](design-audits/architecture-ops.md#2-data-architecture) — no schemas, no migration strategy |

### Desktop Shell / Electron

| App | Reference |
|---|---|
| **Forge** | [review.md Appendix A.7](forge/review.md#a7-desktop-shell-native-bridge-and-distribution) — Electron bridge, WSL, daemon lifecycle, auto-update |
| | [contracts-desktop.md](forge/contracts-desktop.md) — IPC bridge (22 channels), preload API |
| **CodexMonitor** | [review.md §2 Architecture](codexmonitor/review.md#2-architecture-overview) — Tauri (Rust) desktop shell |
| **Paseo** | [desktop-relay.md](paseo/desktop-relay.md) — Electron wrapper, daemon supervision |
| | [implementation-details/03](paseo/implementation-details/03-cli-and-desktop.md) — CLI and desktop details |

### Settings / Configuration

| App | Reference |
|---|---|
| **Forge** | [review.md Appendix A.1](forge/review.md#a1-app-shell-navigation-and-settings) — general settings, provider admin, diagnostics |
| | [server.md §17 Configuration Services](forge/server.md#17-configuration-services) — settings service, keybindings |
| **CodexMonitor** | [review.md Appendix A.7](codexmonitor/review.md#a7-agent-settings-models-collaboration-apps-and-other-settings) — 13 settings sections, Codex/model/agent controls |
| | [frontend.md](codexmonitor/frontend.md) — settings components |
| **Paseo** | [server.md §13 Configuration](paseo/server.md#13-configuration) — config resolution, trust boundaries |
| | [implementation-details/05](paseo/implementation-details/05-server-services-and-config.md) — config resolution details |

### Security / Encryption / Auth

| App | Reference |
|---|---|
| **Forge** | No auth system (single-user) |
| **CodexMonitor** | [review.md §8 Remote/Daemon](codexmonitor/review.md#8-remotedaemon-architecture) — token auth for remote mode only |
| **Paseo** | [review.md §8 Security and Remote Access](paseo/review.md#8-security-and-remote-access) — Curve25519 ECDH + NaCl, E2E encryption |
| | [desktop-relay.md](paseo/desktop-relay.md) — encrypted relay transport |
| | [server.md §14 Security](paseo/server.md#14-security) — security implementation |
| **Our docs** | [design-audits/architecture-ops.md §6](design-audits/architecture-ops.md#6-security-architecture) — no auth mechanism, no token model, no encryption spec |

---

## Backlog Item Reference Map

| Backlog Item | Relevant References |
|---|---|
| **BL-001** Accept ADRs | All design audits identify this as a process blocker |
| **BL-002** Wire format | [design-audits/architecture-ops.md §3](design-audits/architecture-ops.md#3-ipc-and-transport), Forge: [server.md §3](forge/server.md#3-websocket-api-surface-wsts), CodexMonitor: [backend.md §5](codexmonitor/backend.md#5-codex-integration), Paseo: [server.md §4](paseo/server.md#4-websocket-protocol) |
| **BL-003** Database schemas | [design-audits/architecture-ops.md §2](design-audits/architecture-ops.md#2-data-architecture), Forge: [server.md §7](forge/server.md#7-persistence-layer) (34 migrations — primary reference), Paseo: [server.md §12](paseo/server.md#12-persistence-model) |
| **BL-004** API payload contracts | Forge: [contracts-desktop.md](forge/contracts-desktop.md) (69 event types — primary reference), Paseo: [server.md §4](paseo/server.md#4-websocket-protocol) |
| **BL-005** Auth and token model | [design-audits/architecture-ops.md §6](design-audits/architecture-ops.md#6-security-architecture), Paseo: [review.md §8](paseo/review.md#8-security-and-remote-access), [desktop-relay.md](paseo/desktop-relay.md) |
| **BL-006** Dependency graph | [design-audits/architecture-ops.md §10](design-audits/architecture-ops.md#10-internal-consistency), [design-audits/git-workflow.md §7](design-audits/git-workflow.md#7-internal-consistency) |
| **BL-007** pauseRun/steerRun | [design-audits/runtime-execution.md §3](design-audits/runtime-execution.md#3-provider-driver-contract), CodexMonitor: [review.md Appendix A.2](codexmonitor/review.md#a2-queue-steer-stop-pause-resume-and-multi-agent-semantics) (detailed behavioral analysis) |
| **BL-008** Run state machine | [design-audits/runtime-execution.md §2](design-audits/runtime-execution.md#2-run-state-machine-analysis), Forge: [review.md §3.2](forge/review.md#32-session-lifecycle), [server.md §12](forge/server.md#12-session-types-and-lifecycle) |
| **BL-009** Intervention states | [design-audits/runtime-execution.md §4](design-audits/runtime-execution.md#4-queueintervention-model), CodexMonitor: [review.md Appendix A.2](codexmonitor/review.md#a2-queue-steer-stop-pause-resume-and-multi-agent-semantics) |
| **BL-010** Invite delivery | [design-audits/session-collaboration.md §6](design-audits/session-collaboration.md#6-critical-gaps) — no reference app implements invites |
| **BL-013** Sequence assignment | [design-audits/architecture-ops.md §10](design-audits/architecture-ops.md#10-internal-consistency) (contradiction identified), Forge: [server.md §5](forge/server.md#5-orchestration-engine) |
| **BL-014a** Workflow V1 scope | [design-audits/git-workflow.md §4](design-audits/git-workflow.md#4-workflow-model-assessment), Forge: [review.md §3.3](forge/review.md#33-workflow-engine), [contracts-desktop.md](forge/contracts-desktop.md) |
| **BL-014b** Expand Spec-017 | Same as BL-014a plus Forge: [review.md Appendix A.3](forge/review.md#a3-workflows-discussions-plans-and-human-gates) |
| **BL-015** Driver capability matrix | Forge: [review.md §5](forge/review.md#5-provider-driver-model), CodexMonitor: [review.md §5](codexmonitor/review.md#5-codex-integration-model), Paseo: [review.md §5](paseo/review.md#5-provider-normalization-model), [implementation-details/09](paseo/implementation-details/09-provider-transports-and-features.md) |
| **BL-016** Membership conflicts | [design-audits/session-collaboration.md §5](design-audits/session-collaboration.md#5-open-questions) |
| **BL-017** Session/channel limits | Forge: [review.md §10](forge/review.md#10-limitations-and-gaps) (no queue depth management), CodexMonitor: [review.md Appendix A.7.3](codexmonitor/review.md#a73-agent-settings) (max_threads/max_depth caps) |
| **BL-019** Workspace-to-worktree binding | [design-audits/git-workflow.md §2](design-audits/git-workflow.md#2-repoworkspaceworktree-model-assessment), Forge: [review.md §3.8](forge/review.md#38-git-integration) |
| **BL-020** DiffArtifact schema | [design-audits/git-workflow.md §7](design-audits/git-workflow.md#7-internal-consistency) (dual identity issue) |
| **BL-021** Approval categories | [design-audits/git-workflow.md §5](design-audits/git-workflow.md#5-approval-and-trust-model-assessment), Forge: [review.md §3.6](forge/review.md#36-interactive-request-system) (8 request types — reference enum) |
| **BL-024** Steer injection | CodexMonitor: [review.md Appendix A.2.1](codexmonitor/review.md#a21-queue-vs-steer) (detailed steer behavioral analysis) |
| **BL-027** V1 feature scope | All three review.md files §4 "Signature Feature Analysis" — cross-app feature gap tables |
| **BL-028** Workflow domain models | Forge: [contracts-desktop.md](forge/contracts-desktop.md) (workflow types, phase types) |
| **BL-029** Control-plane transport | [design-audits/architecture-ops.md §3](design-audits/architecture-ops.md#3-ipc-and-transport), Paseo: [desktop-relay.md](paseo/desktop-relay.md) (relay architecture) |
| **BL-037** Git hosting adapter | [design-audits/git-workflow.md §8](design-audits/git-workflow.md#8-open-questions-and-critical-gaps), Forge: [server.md §13](forge/server.md#13-git-operations) (GitHubCli implementation) |
