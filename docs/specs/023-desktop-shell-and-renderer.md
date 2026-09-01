# Spec-023: Desktop Shell And Renderer

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `023` |
| **Slug** | `desktop-shell-and-renderer` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude (AI-assisted)` |
| **Depends On** | [ADR-016: Electron Desktop Shell](../decisions/016-electron-desktop-shell.md), [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md), [ADR-009: JSON-RPC IPC Wire Format](../decisions/009-json-rpc-ipc-wire-format.md), [Container Architecture](../architecture/container-architecture.md), [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md), [Security Architecture](../architecture/security-architecture.md), [Spec-007: Local IPC And Daemon Control](./007-local-ipc-and-daemon-control.md) |
| **Implementation Plan** | [Plan-023: Desktop Shell And Renderer](../plans/023-desktop-shell-and-renderer.md) |

> **Amendment (2026-08-18, desktop edit-affordance placement — the renderer entry point for Plan-004's atomic edit-and-resend composite; user-ratified, §6 node NS-73).** Flips the previously-`approved` spec to `review` per the audit runbook's spec-amendment rule, since it adds normative §Signature Feature Composition Sketches and §Acceptance Criteria text and materially re-derives two of that section's interaction enumerations, and **restores `approved` in the same diff** through the targeted readiness-audit delta riding it — the same-PR flip-and-restore shape [Plan-004](../plans/004-queue-steer-pause-resume.md) and [Plan-013](../plans/013-live-timeline-visibility-and-reasoning-surfaces.md) take in this swap; [Plan-023](../plans/023-desktop-shell-and-renderer.md)'s paired-spec Preconditions box carries the scoped Re-opened/Delivered record. **The growth.** The Timeline View sketch gains the placement of the edit-and-resend entry point: a hover-revealed pencil affordance in the participant `user.message` row's footer, opening an inline editor with a Cancel action and a confirm action that dispatches the **existing** `rollback` intervention carrying `replacementSend`. It is an entry point into a control the corpus already has — **not a new run control** — so `Spec-004 §Resolved Questions and V1 Scope Decisions`' V1 control set stays closed and Spec-004 takes nothing normative from this amendment. The eligibility predicate, the three-state fail-closed visibility (hidden while dormant, disabled without the declared driver capability, disabled-with-a-stated-reason on transient guard failure), and the dim-not-remove in-flight treatment are **owned by [Plan-004](../plans/004-queue-steer-pause-resume.md)** (I-004-24, T4.8); this spec records the placement and the projection, consistent with this section's own standing rule that the owning plan is the canonical source of feature behavior and the renderer is a read-and-steer projection of it. [Plan-013](../plans/013-live-timeline-visibility-and-reasoning-surfaces.md) T4.2 hosts the mount at the row-footer composition point (CP-004-15), the host-mounts/owner-authors split. §Acceptance Criteria gains the matching criterion — the footer placement, the dispatch into the existing `rollback` control, and the render-the-projection-never-re-derive rule — **appended last** so no existing bullet's position moves; these criteria are unnumbered by standing convention and are cited by heading-plus-behavior-name rather than by a synthesized ordinal, which is the form [Plan-004](../plans/004-queue-steer-pause-resume.md) T4.8 uses to claim it. **One repair rides the same sweep** for a defect this amendment itself introduced: adding text above shifts this file's line numbering, so the four `Spec-023 line NNN` anchors [Plan-016](../plans/016-multi-agent-channels-and-orchestration.md) Phase 4 aimed at this spec are converted to the drift-proof §-anchor-plus-descriptor form rather than renumbered — a cite-form change carrying no normative edit to that plan. **Two pre-existing defects repaired in the same sweep**, both on the Runs View interaction enumeration: `rollback` had been absent since the campaign-B2 amendment made it a first-class intervention type (its desktop control gate authored by campaign B9 at Plan-004 T4.2), and is restored; and the enumeration listed a queue **reorder** interaction contradicting `Spec-004 §Resolved Questions and V1 Scope Decisions`' V1 deferral of queue priority overrides — no reorder wire surface exists, the queue's only V1 removal path being `run.queueCancel` — so the gloss is struck rather than left standing. **Mints nothing**: no preload-bridge capability, method string, wire member, error code, table, or column; no census moves.

> **Amendment (2026-08-25, deep-link invite-confirmation transport split — the consuming-leg assignment for [Plan-023](../plans/023-desktop-shell-and-renderer.md)'s Tier-8 deep-link surface; §6 node NS-81).** Flips the previously-`approved` spec to `review` per the audit runbook's spec-amendment rule and **restores `approved` in the same diff** through the targeted readiness-audit delta riding it — the same-PR flip-and-restore shape the NS-63 / NS-65..NS-74 swaps take; [Plan-023](../plans/023-desktop-shell-and-renderer.md)'s paired-spec Preconditions box carries the scoped Re-opened/Delivered record. **The growth.** §Deep-Link Invite Flow's non-consuming-preview pin closed by assigning the shell's consumption leg to [Plan-008](../plans/008-control-plane-relay-and-session-join.md)'s Tier-5 invite-acceptance handoff — the daemon gateway — which is the **opposite** transport from the one steps 2 and 5 of that same flow require, since a token routed through the daemon has by definition left the main process that step 2 confines it to. The pin now splits the two desktop consuming legs by transport: the **in-app** invite-accept view rides the Plan-008 Tier-5 handoff (Plan-002 CP-002-9), while the **deep-link** leg specified here issues the preview over the main process's own control-plane client and never the daemon gateway (Plan-023 CP-023-5). **Why this is a flip and not an erratum:** the sentence _assigns a mechanism_, so an implementer reading this spec builds a different client path before and after — the discriminating fact, rather than whether a contradiction was removed. The governing precedent is the 2026-08-18 amendment above, which flipped this same spec for materially re-derived interaction enumerations, a lighter class than reassigning a leg's transport. **Ownership is unchanged**: §Deep-Link Invite Flow already mandates preview-then-confirm and delegates the opaque reference's shape, lifecycle, and error semantics to Plan-023 Tier 8, which authors them at T-023r-2-5 (the `invite` preload-bridge namespace and its wire contract), T-023r-5-5 (the main-side preview and reference lifecycle), T-023r-6-3 (the renderer confirmation surface), and T-023r-8-5 (the two-client smoke), under I-023-9 / I-023-10 and CP-023-5. **One line-numbering note**, since this blockquote grows the file: the 2026-08-18 amendment converted the last inbound `Spec-023 line NNN` anchors to the §-anchor-plus-descriptor form, and a fresh repo-wide sweep over the `.md` corpus and the code tree finds zero surviving numeric line cites into this spec, so the growth renumbers no citer. **A second, larger repair rides the same flip:** §Example Flows' deep-link bullet still narrated auto-accept on protocol fire — parse the token, call `acceptInvite`, navigate — with no preview and no confirmation, contradicting §Deep-Link Invite Flow steps 3-5, this section's own property (b), and the acceptance-requires-confirmation invariant it delegates to Plan-023 (I-023-9). It is rewritten to the preview-then-confirm sequence, and its stale claim that `session:joined` is a bridge event is corrected: `session:joined` is an internal main-process signal, and the renderer receives the membership result over `invite.subscribeOutcome`. **Mints nothing**: no preload-bridge capability, method string, wire member, error code, table, or column; the Status ends `approved`, so no census moves. [BL-133](../backlog.md#bl-133-non-consuming-invite-metadata-endpoint-for-the-deep-link-confirmation-surface) stays open on its criterion (c) — a two-client smoke that must _pass_ — narrowed onto T-023r-8-5 as its named exit vehicle.

> **Amendment (2026-08-26, provider-management page — the renderer surface for [Spec-029](029-provider-accounts-and-credential-homes.md)'s brokered sign-in, bounded token registration, health observer, and per-limit quota; the CP-029-10 reciprocal, landed with its restoring targeted readiness-audit delta riding the same diff, cross-plan §6 node NS-83).** Flips the previously-`approved` spec to `review` per the audit runbook's spec-amendment rule and **restores `approved` in the same diff**, the in-swap shape this spec's 2026-08-18 and 2026-08-25 legs took. Grows §Provider Accounts And Cost View — whose **owning plan is already Plan-029**, so no ownership moves and this spec authors no new task — along four axes: the settings-level registry row list becomes a two-pane **provider-management page**; the interaction list gains sign-in start and cancel, the write-only token supply, the observer opt-out, correct, and probe-now; quota renders per `(account, limit)` rather than per account; and the re-login horizon renders as an **approximation, omitted rather than fabricated** where the daemon reports it unknown. Two rules are stated because their absence would be a defect rather than a gap: the token field is write-only **in the renderer too** — masked, never read back, never in serializable renderer state a devtools inspection or crash report would capture — and the page **derives no eligibility of its own**, rendering what the daemon reports and disabling what it does not, the fail-closed-projection discipline `I-004-24` already states for the edit affordance. **No census move**: no wire member, method, error code, table, or column is minted here; every one of them is [Spec-029](029-provider-accounts-and-credential-homes.md)'s, and the Signature Feature enumerations in §Scope and §Acceptance Criteria are untouched — this stays an operator-plane view.

> **Amendment + restoration (2026-09-01, console design — Meridian, the console surface set, the pane and window model, the fixture bridge, and the Electron 44 floor; user-ratified 2026-09-01; in-swap flip-and-restore riding the paired [Plan-023](../plans/023-desktop-shell-and-renderer.md) targeted readiness-audit delta; [cross-plan-dependencies.md §6](../architecture/cross-plan-dependencies.md) node NS-97).** Flips the previously-`approved` spec to `review` per the audit runbook's spec-amendment rule — it adds a normative §Required Behavior subsection (§Console Design (Meridian)), grows §Scope, re-derives two §Non-Goals bullets, and appends five §Acceptance Criteria — and **restores `approved` in the same diff**, the shape this spec's 2026-08-18, 2026-08-25, 2026-08-26, and 2026-08-29 legs took. **The growth.** §Non-Goals had deferred renderer visual design, component-library choice, and the theme system to "the design track" since this spec was authored. That track has now run — a whole-corpus surface survey, a reference-mechanics study that adopts mechanics and never skin, and a cited library-leverage pass — and its result lands here as `§Console Design (Meridian)`: the four product bars (richness, elegance, zero copy, light on the machine); the nine-part Meridian design language; the eight rules every console surface obeys; the console surface set — the three-destination icon rail, the all-sessions list, the session workspace as cast bar + deck + sidebar, the **closed** pane-kind set, and the two auxiliary windows §Main Process Responsibilities had already named as optional and which now ship as hardened `BrowserWindow`s with their own bridge instance; the fixture bridge, shape-identical to `SidekicksBridge` namespace for namespace, that lets the whole console be built and regression-tested before every daemon method it calls exists; and the budgets — renderer heap, idle and streaming CPU, frame time, bundle size — that gate every console PR. §Implementation Notes gains the library verdicts (`§Console Libraries`, ADOPT / ADOPT-with-constraints / OWN-BUILD / AVOID per axis, each carried with its evidence in §References) and the console test tiers. **The Electron floor moves.** Electron 41 reached end-of-support on 2026-08-25 with the 44.0.0 release, so V1 targets **Electron 44.x** (44.1.1 at authoring); [ADR-016 §Decision](../decisions/016-electron-desktop-shell.md#decision) is amended in the same swap to the 42 / 43 / 44 supported-branch subset, and the `electron-builder` / `electron-updater` pins are re-derived from the registry (26.15.x / 6.8.9). **Three conflict resolutions, each in favour of the owning spec.** Notification mute is **global only** — [Spec-019 §Resolved Questions and V1 Scope Decisions](019-notifications-and-attention-model.md#resolved-questions-and-v1-scope-decisions) keeps preferences global in V1 — so §Default Behavior's per-session mute is struck; the Invites View's "decline" becomes a **local hide**, since [Spec-002](002-invite-membership-and-presence.md) defines declining as implicit and mints no verb; and no renderer repo-detach control exists, [Spec-009 §Detach Semantics (V1 Definition)](009-repo-attachment-and-workspace-binding.md#detach-semantics-v1-definition) making detach SDK / CLI-only. **Errata riding the same sweep, none normative:** the §Non-Goals workflow-authoring bullet still said the engine was V1.1, stale against the 2026-04-22 [ADR-015](../decisions/015-v1-feature-scope-definition.md) amendment (workflows are V1 feature 17, Spec-017 / Plan-017, the builder under [ADR-026](../decisions/026-visual-node-graph-workflow-authoring.md)) and is corrected; two cites named Spec-007 headings that do not exist (`§Failure Modes`, `§Version Negotiation`) and now cite `Spec-007 §Fallback Behavior`; and the Timeline View's and §Acceptance Criteria's "sixth run control" phrasing is made **count-free**, because the V1 control set's own enumeration in `Spec-004 §Resolved Questions and V1 Scope Decisions` had omitted `cancel` — an `InterventionType` member since Tier 1 — and is corrected there in the same sweep. **Where the code lands.** The console is built on lane 1 as [Plan-023](../plans/023-desktop-shell-and-renderer.md)'s Tier-1 explicit-label supplement Phase 1C ([CONTRIBUTING.md §How Code Lands: Work Classification](../../CONTRIBUTING.md#how-code-lands-work-classification) lane 1 — title token, manifest rows, by-label preflight) inside this spec's envelope, over the Phase-1B renderer-load substrate, against the fixture bridge for every wire the corpus has not yet registered; one Plan-023 invariant is minted for it (I-023-11, shipped by Plan-023's Phase 1B): the renderer scheme must be registered `standard: true` before `app.ready`, or the persistence the console relies on does not exist (§Renderer Bundle). **Mints**: no wire method, event type, error code, table, or column; Plan-023 gains invariants I-023-11 and I-023-12 and a console growth slate that names, in git, every wire the console builds against the fixture and does not yet have. No census moves.

> **Amendment + restoration (2026-08-29, desktop-console parity — the session composer and the MCP-servers operator page; in-swap flip-and-restore riding the [Spec-005](005-provider-driver-contract-and-capabilities.md) desktop-console parity amendment's own diff; the header flips to `review` under the audit runbook's spec-amendment rule and is restored `approved` by the paired [Plan-023](../plans/023-desktop-shell-and-renderer.md) targeted readiness-audit delta in this same swap; [cross-plan-dependencies.md §6](../architecture/cross-plan-dependencies.md) node NS-93).** Two sketches join §Signature Feature Composition Sketches, taking it from six sub-views to **eight**, and one existing sketch grows by two bullets. **(1) The Session Composer**, the shell chrome every session view already contains and which this spec had never sketched — so the affordances that live in it had nowhere to be composed. It carries the provider command-and-skill autocomplete, keyed on the **target agent's** `(driverName, providerAccountId)` binding, which is `Spec-005 §The provider command and skill surface`'s routing invariant expressed as an interaction rather than restated as a second rule: a Claude-enumerated command is never offered in a composer addressed to a Codex agent. It also names the mount points for the participant-triggered compaction control and the output-speed control, both authored elsewhere. **(2) The MCP Servers view**, an **operator-plane** page on the exact 2026-08-26 Provider Accounts And Cost View precedent: [Spec-028](028-mcp-server-configuration-and-governance.md) has carried a complete governance wire surface and named a desktop panel in passing since it was written, with no composition sketch anywhere in this spec. It composes that existing surface, derives no eligibility of its own, and sends one wire mutation per explicit user action. **(3) The Timeline View** gains the input-ask card row and its answer interaction ([Spec-013](013-live-timeline-visibility-and-reasoning-surfaces.md)). Both new sketches carry the `Note` the section's own rule requires, so the Signature Feature enumerations in §Scope and §Acceptance Criteria still name exactly the features they always did — the composer is shell chrome and the MCP page is operator-plane, and neither is a Signature Feature. **No wire method, event type, error code, table, or column is minted here**: every method these views call is already registered by its owning plan, and no census moves.

## Purpose

Define the Electron desktop shell (main process + preload) and React + Vite renderer for AI Sidekicks — the second client delivery track after the CLI (per `container-architecture.md` §Client Delivery Sequence). This spec specifies:

- the shell/renderer process boundary and the preload bridge capability surface
- main-process responsibilities (windowing, native dialogs, notifications, deep-link handling, daemon supervision, auto-update, native keystore access, WebAuthn orchestration)
- renderer composition for each V1 Signature Feature view
- code-signing, notarization, and distribution across macOS (arm64 + x64), Windows 10/11 (x64), and Linux (x64 + arm64)
- the explicit renderer-untrusted trust stance required to keep auth material out of renderer reach

## Scope

In scope:

- Electron main-process architecture and lifecycle
- Preload bridge contract (capability surface between renderer and main)
- Renderer composition of V1 Signature Features (timeline, approvals, invites, runs, multi-agent channels)
- The console design language (Meridian), the console surface set, the pane and window model, the budgets, and the fixture bridge the renderer is built and tested against (§Console Design (Meridian))
- Daemon supervision from the shell (start, stop, health, crash recovery, version pinning)
- Auto-update flow, signature verification, and rollback safety
- Code-signing and notarization for all three V1 platforms
- WebAuthn (including the PRF extension) orchestration for desktop credential flows
- OS-keystore integration for persistent auth material
- Deep-link handling for invite URLs
- Security hardening posture (contextIsolation, sandbox, Electron Fuses, CSP)
- Crash reporting for main, renderer, and supervised-daemon process crashes
- Accessibility baseline (OS-level screen-reader and high-contrast compliance; WCAG 2.2 AA for every console route and dialog per §Console Design (Meridian))

## Non-Goals

- Pixel-level mockups and per-screen visual specifications. `§Console Design (Meridian)` fixes the design language, the surface set, the pane and window model, the budgets, and — through `§Console Libraries` — the component-library and theme decisions; the per-surface composition (what each surface renders, offers, and refuses, and its density budget) is the console's own code and fixture scenarios under Plan-023's console registration. _Re-derived 2026-09-01: the prior bullet deferred all three to a design track that has since run and landed here._
- Daemon internals (owned by `component-architecture-local-daemon.md` and Spec-007)
- Control-plane authentication protocol details (owned by Spec-008 and ADR-010)
- Mobile or browser-hosted renderer surfaces (out of V1 per ADR-015; browser-only local clients explicitly out of scope per `Spec-007 §Resolved Questions and V1 Scope Decisions`)
- The CLI client (Spec-007 owns the IPC contract the renderer reuses; CLI-specific UX is out of scope here)
- Provider-driver internal protocols (owned by Spec-005)
- Workflow authoring semantics — the engine, the definition model, the human-phase forms — owned by [Spec-017](./017-workflow-authoring-and-execution.md) / Plan-017 (V1 feature 17 since the 2026-04-22 [ADR-015](../decisions/015-v1-feature-scope-definition.md) amendment) with the node-graph builder under [ADR-026](../decisions/026-visual-node-graph-workflow-authoring.md); the renderer composes those surfaces as the `workflow-run` and `workflow-builder` pane kinds of `§Console Design (Meridian)` and this spec restates none of their behavior. _Erratum corrected 2026-09-01: the prior bullet still called the engine V1.1._

## Domain Dependencies

- [Session Model](../domain/session-model.md) — session, participants, runs, channels
- [Participant And Membership Model](../domain/participant-and-membership-model.md) — role/capability surface the renderer reflects
- [Run State Machine](../domain/run-state-machine.md) — run-view state the renderer projects
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md) — approval + diff views
- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md) — multi-agent channel view

## Architectural Dependencies

- [ADR-016: Electron Desktop Shell](../decisions/016-electron-desktop-shell.md) — Electron as the V1 shell and authoritative source for the supported stable-branch floor; the forward declaration this spec implements
- [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md) — desktop credential path (WebAuthn PRF); this spec is the shell-side implementation surface
- [ADR-009: JSON-RPC IPC Wire Format](../decisions/009-json-rpc-ipc-wire-format.md) — wire format the preload bridge forwards
- [Container Architecture](../architecture/container-architecture.md) — renderer-untrusted trust boundary; canonical monorepo topology
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md) — shell/renderer/client-SDK component boundaries
- [Security Architecture](../architecture/security-architecture.md) — auth material handling and trust boundaries (§Local Daemon Authentication reconciled with this spec under BL-056 on 2026-04-18)
- [Spec-007: Local IPC And Daemon Control](./007-local-ipc-and-daemon-control.md) — the typed daemon contract the renderer reuses via the shared client SDK

## Required Behavior

### Process Model

The desktop application must run as three cooperating processes:

1. **Shell (Electron main process).** Node.js runtime. Owns windowing, native dialogs, notifications, deep-link protocol handler, daemon supervision, auto-updater, OS-keystore access, WebAuthn orchestration, and all session-scoped auth material.
2. **Renderer (Electron renderer process, one per window).** Chromium with `contextIsolation: true` and `sandbox: true`. Loads the React + Vite bundle. Has no direct Node.js access and no direct filesystem, network, or OS access — all such capabilities flow through the preload bridge.
3. **Local Daemon (spawned child process of the shell, or external service).** Runs `packages/runtime-daemon/`. The shell supervises it via the `DaemonStart`, `DaemonStop`, `DaemonRestart`, and `DaemonStatusRead` surface from Spec-007. The daemon owns all execution authority.

The renderer must never fork, spawn, or exec a process. The renderer must never open a filesystem handle or a network socket directly — every such operation flows through the preload bridge and is enforced in the shell's main process.

### Trust Stance

The renderer is **untrusted** relative to the shell and daemon, consistent with `container-architecture.md` §Trust Boundaries and `component-architecture-desktop-app.md` §Trust Boundaries.

The shell (main process) holds all of the following; the renderer never holds any of them:

- the local daemon session token from `$XDG_RUNTIME_DIR/ai-sidekicks/daemon.token` per Security Architecture §Local Daemon Authentication (loaded at shell startup)
- the PASETO v4.public access token issued by the Collaboration Control Plane per ADR-010
- the PASETO v4.local refresh token per ADR-010
- the ephemeral Ed25519 DPoP private key bound to the access token per Security Architecture §Control-Plane Authentication
- WebAuthn PRF-derived credential-wrapping keys per ADR-010
- any participant-identity private-key material stored in the OS keystore

All renderer-originated daemon or control-plane requests flow through the preload bridge, which:

1. validates the request against a narrow capability-typed contract brokered to the renderer at session start
2. attaches the session token (for daemon calls) or the PASETO access token + DPoP proof (for control-plane calls) in the main process
3. forwards the request over the Spec-007 Content-Length JSON-RPC transport (daemon) or the ADR-014 tRPC / WebSocket transport (control plane)
4. returns only the sanitized response payload to the renderer — never the raw auth headers

`security-architecture.md` §Local Daemon Authentication was reconciled with this spec's renderer-untrusted stance under BL-056 on 2026-04-18. It now states that the renderer is **not a direct daemon client**; all renderer-originated requests flow through the preload bridge to the Desktop Shell, which forwards them to the daemon with attached auth headers. The Shell and CLI both present the 256-bit session token at daemon-connect time (token is primary; socket permissions 0700 are defense-in-depth). The prior "trusted local process" framing and the "token optional for renderer / CLI" permission have been removed.

### Security Hardening Baseline

Every `BrowserWindow` must be created with the following `webPreferences`:

```ts
{
  contextIsolation: true,          // must be true; isolates preload from renderer
  sandbox: true,                   // must be true; renderer runs in OS-level sandbox
  nodeIntegration: false,          // must be false; no Node APIs in renderer
  nodeIntegrationInWorker: false,  // must be false
  webSecurity: true,               // must be true; enforces same-origin
  preload: '<absolute path>',      // preload script registered here
  // no remoteModule (removed in Electron >= 14)
}
```

Every renderer document must be served with a strict `Content-Security-Policy`. At minimum:

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
connect-src 'self' https://<configured-control-plane-origin> wss://<configured-relay-origin>;
img-src 'self' data: blob:;
font-src 'self';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
```

Electron Fuses — the shell binary must be packaged with the following fuses (see [Implementation Notes §Electron Fuses](#electron-fuses) for rationale and primary-source citations):

- `RunAsNode`: **disabled** — prevents the shipped Electron binary from running as a generic Node.js runtime via `ELECTRON_RUN_AS_NODE`
- `EnableCookieEncryption`: **enabled** — encrypts the cookie store at rest using OS-level primitives
- `EnableNodeOptionsEnvironmentVariable`: **disabled** — prevents `NODE_OPTIONS` / `NODE_EXTRA_CA_CERTS` from injecting code at startup
- `EnableNodeCliInspectArguments`: **disabled** — prevents `--inspect` and `--inspect-brk` debugger flags at the Electron command line
- `EnableEmbeddedAsarIntegrityValidation`: **enabled** — verifies asar-bundle integrity at load time (graduated from experimental to stable in Electron 39; now available on Linux via digest mode as of Electron 41)
- `OnlyLoadAppFromAsar`: **enabled** — refuses to load the app from anywhere other than the signed asar
- `LoadBrowserProcessSpecificV8Snapshot`: **enabled** — prevents renderer V8 snapshots from leaking into the browser process
- `GrantFileProtocolExtraPrivileges`: **disabled** — refuses to grant privileged APIs to `file://` origins; the renderer is served via a custom protocol, not `file://`
- `WasmTrapHandlers`: **enabled** (default) — required for WASM memory safety without perf cost

In addition to the Fuses above, release builds must embed an **ASAR Integrity Digest** (new in Electron 41 via `@electron/asar` v4.1.0+, invoked as `asar integrity-digest on /path/to/YourApp.app`). Digest generation must run **before** the code-signing step because toggling fuses and embedding the digest both invalidate the signature.

### Preload Bridge Contract

The preload script exposes a single typed object on `window.sidekicks` via `contextBridge.exposeInMainWorld`. The object surface must be declarative, narrow, and capability-scoped.

```ts
interface SidekicksBridge {
  // daemon RPC — request/response over Spec-007 JSON-RPC contract
  daemon: {
    call<M extends DaemonMethod>(method: M, params: DaemonParams<M>): Promise<DaemonResult<M>>;
    subscribe<E extends DaemonEvent>(
      event: E,
      handler: (payload: DaemonEventPayload<E>) => void,
    ): Unsubscribe;
  };

  // control-plane RPC — request/response over tRPC; presence/collaboration events over WebSocket JSON-RPC 2.0 (relay traffic rides Spec-008's binary wire frames, not JSON-RPC). Session-timeline / run-output streams are tRPC SSE per Spec-008 — this bridge does not yet expose them; a typed `subscribe` surface lands with the plan wiring renderer control-plane subscriptions (the contracts bridge shape in `packages/contracts` is verbatim-bound to this block; that binding fixes the **Tier-1** shape, and a Tier-8 namespace joins it only where a spec section names its owner — `invite` above, delegated by §Deep-Link Invite Flow to Plan-023, and `onboarding`, delegated by `Spec-026 §Desktop Surface` to Plan-023 for the surface and Plan-026 for the flow body. A namespace with no such named delegation is drift)
  controlPlane: {
    call<P extends CpProcedure>(procedure: P, input: CpInput<P>): Promise<CpOutput<P>>;
    subscribeRelay(sessionId: SessionId, handler: RelayEventHandler): Unsubscribe;
  };

  // native capabilities — renderer requests, main performs, sanitized result returned
  native: {
    showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogResult>;
    showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogResult>;
    showMessageBox(options: MessageBoxOptions): Promise<MessageBoxResult>;
    showNotification(options: NotificationOptions): void;
    openExternal(url: string): Promise<void>; // main-process allowlist-validated
    copyToClipboard(text: string): Promise<void>;
    revealInFileExplorer(path: FilePathRef): Promise<void>;
  };

  // WebAuthn — renderer cannot call navigator.credentials.* directly under strict CSP;
  //           main process orchestrates the WebAuthn ceremony via Electron's bindings
  webAuthn: {
    createCredential(options: PublicKeyCredentialCreationOptions): Promise<PublicKeyCredential>;
    getAssertion(options: PublicKeyCredentialRequestOptions): Promise<PublicKeyCredential>;
    deriveKeyMaterial(input: PrfInput): Promise<ArrayBuffer>; // PRF extension per ADR-010
  };

  // auto-update — renderer observes state; main process drives
  update: {
    getState(): Promise<UpdateState>;
    subscribe(handler: (state: UpdateState) => void): Unsubscribe;
    requestCheck(): Promise<void>;
    requestRestart(): Promise<void>;
  };

  // deep-link invite confirmation — main confines the token and hands the renderer
  //   an opaque, single-use, TTL-bounded reference; see §Deep-Link Invite Flow
  invite: {
    subscribePending(handler: (state: PendingInviteState) => void): Unsubscribe;
    subscribeOutcome(handler: (outcome: InviteOutcome) => void): Unsubscribe;
    confirmPending(reference: PendingInviteRef): Promise<void>;
    retryPending(attempt: InviteAttemptRef): Promise<void>;
    dismissPending(reference: PendingInviteRef): Promise<void>;
  };

  // app meta — read-only
  app: {
    version: string;
    platform: "darwin" | "linux" | "win32";
    arch: "arm64" | "x64";
    locale: string;
  };
}
```

The bridge must not expose:

- raw `ipcRenderer` or `ipcMain`
- `require`, `process`, `global`, or any Node built-in
- auth material (daemon session token, PASETO tokens — including the R3-issued relay `connectionToken`, a PASETO v4.public `aud=relay-connect` credential — DPoP key, WebAuthn PRF output) in any form — PRF output is derived and consumed inside main-process-owned caches; the relay `connectionToken` is likewise main-process-confined (relay negotiation runs main-owned and consumes it to open the relay WSS — see §Interfaces And Contracts), never returned across the bridge
- arbitrary file paths as strings — path-as-capability never crosses the bridge as a raw string: every NATIVE/file-system OPERATION the renderer requests takes or returns opaque `FilePathRef` tokens (`revealInFileExplorer(path: FilePathRef)`), and dereferencing a token requires a second main-process round trip. Display-only path VALUES carried inside daemon- or control-plane-owned payload data (e.g. Spec-009's `canonicalRoot` / `fsRoot` repo-and-workspace fields, which the repo-attach renderer renders verbatim so a participant can verify what was attached) are data, not capabilities: the renderer may render them as text, but no bridge surface accepts a raw path string for any OS or filesystem action. Renderer-SUPPLIED path strings inside daemon request payloads (Spec-009's user-entered `RepoAttachRequest.localPath`) are permitted as data for the same reason; the daemon's trust-envelope validation (`Spec-009 §Required Behavior`) is the enforcement point, never the renderer. _(Amended by the Tier-6 plan-readiness audit, Plan-009 Phase 4 walk — co-recorded for the Plan-023 Tier-8 audit.)_

> **Parameterized daemon subscriptions — the `daemon.subscribe` signature is a Tier-1 placeholder (pin).** The generic `daemon.subscribe<E>(event, handler)` above carries an event name and a handler but **no request-parameter channel**, so it is incomplete for any daemon subscription that needs per-subscription parameters. `presence.subscribe` is the concrete case surfaced by the Plan-002 Phase 6 renderer: the daemon **requires** a `{ sessionId }` request body for it — `PresenceSubscribeRequestSchema` (`packages/contracts/src/presence.ts`) is `z.object({ sessionId }).strict()`, the runtime-daemon `presence.subscribe` handler validates that schema before dispatch, and the client SDK's `subscribePresence` already sends `{ sessionId }` on the wire. The generic signature cannot express that today (contrast `controlPlane.subscribeRelay(sessionId, handler)`, the one subscribe that already threads a parameter). **Decision pinned:** the daemon-subscribe bridge surface MUST be able to carry each subscription's request parameters; the current param-less signature is a placeholder, not the target. **Deferred to [Plan-007: Local IPC And Daemon Control](../plans/007-local-ipc-and-daemon-control.md) / [Plan-008: Control Plane Relay And Session Join](../plans/008-control-plane-relay-and-session-join.md):** the signature **shape** — positional param vs options bag vs an event→params/payload map — is owned by the plans that narrow `DaemonEvent` / `DaemonParams` / `DaemonEventPayload` (today Tier-1 `never`-shaped brands in `packages/contracts/src/desktop-bridge.ts`) across **all** daemon methods at once. Fixing the subscribe-params shape here from a presence-only vantage would be premature abstraction that conflicts with that holistic narrowing. As with the [§Deep-Link Invite Flow](#deep-link-invite-flow) pin, this clarifies the flow and pins the requirement, not the data type.

### Main Process Responsibilities

- **App lifecycle.** Single-instance lock (`app.requestSingleInstanceLock()`). Graceful shutdown on `before-quit` — signal the daemon to flush, wait up to a 10-second budget, then force-terminate. Relaunch on update apply.
- **Window management.** Main session window. Two auxiliary windows — the full-screen timeline and the detached agent console — each a hardened `BrowserWindow` per §Security Hardening Baseline with its own preload and its own bridge instance, sharing no in-memory store with the main window (`§Console Design (Meridian)`, the window model; both ship in V1, 2026-09-01). Platform-appropriate menu bar (macOS app menu; Windows/Linux window menu). Tray icon with status (connected / offline / update-available).
- **Native dialog surface.** File open/save, message boxes, system notifications — exposed to renderer via the bridge above.
- **Notifications.** Cross-platform via `Notification` API. Must honor OS Do-Not-Disturb. Click-to-focus must surface the window and navigate to the event source.
- **Deep-link handling.** The shell must register a protocol handler for `sidekicks://` (e.g., `sidekicks://invite/<token>`) on all three platforms. On invocation, the shell parses the URL, routes to the renderer's invite-accept flow, and never exposes the raw token to the renderer — the token is exchanged for a session capability in the main process.
- **Daemon supervision.** Start, stop, restart, and monitor the local daemon via Spec-007's `DaemonStart`/`DaemonStop`/`DaemonRestart`/`DaemonStatusRead` surface. Crash detection triggers automatic restart with exponential backoff (`100ms, 300ms, 1s, 3s, 10s`) up to five attempts, then surfaces a persistent UI error state. Version mismatch (per `Spec-007 §Fallback Behavior`) blocks mutating operations but preserves read-only visibility.
- **Auto-update.** Scheduled checks against the configured feed. Download, verify signature, stage, and apply on relaunch. Surface update state to the renderer via the `update` bridge channel. Rollback on signature-verification failure or post-install daemon handshake failure.
- **OS keystore access.** Store and retrieve the PASETO refresh token, the daemon session token (cached between daemon restarts for fast handshake), and any participant-identity private keys. Encrypted at rest via OS primitives (macOS Keychain, Windows Credential Manager, Linux Secret Service / libsecret with KWallet fallback).
- **WebAuthn orchestration.** Drive the WebAuthn create and get ceremonies on behalf of the renderer via Electron's WebAuthn bindings; return the authenticator assertion through the bridge. Handle the PRF extension per ADR-010 and pass derived key material into the main-process-owned credential-wrap cache — never into the renderer.
- **Crash reporting.** Electron `crashReporter` for main and renderer process crashes. Supervised daemon crashes surface through the Spec-007 supervision contract. All crash payloads must strip PII (session IDs replaced with stable hashes; file paths truncated to extension; no content payloads).

### Renderer Responsibilities

- Render session, orchestration, repo, diff, approval, invite, settings, and workflow-viewer surfaces
- Merge live projections from daemon subscriptions with control-plane subscriptions into a coherent session experience (per `component-architecture-desktop-app.md` §Data Flow)
- Route all privileged operations through the preload bridge
- Never cache auth material (the bridge enforces this; renderer code treats every call as authenticated-by-main)
- Handle disconnection states gracefully: daemon disconnect → reconnect or read-only mode per `Spec-007 §Fallback Behavior`; control-plane disconnect → local continuity with degraded collaboration UI
- Render every surface in the Meridian design language, inside the console surface set, and under the eight console rules of `§Console Design (Meridian)`: a control the caller's role cannot use is absent rather than disabled, a control the daemon may refuse is offered with its typed refusal rendered, and no read runs on an interval

### Console Design (Meridian)

_Added 2026-09-01. This subsection is the design track's landing: it fixes the language, the surface set, the pane and window model, the fixture bridge, and the budgets. Each surface's own composition — what it renders, offers, refuses, and folds — lives in the console's code and its fixture scenarios under Plan-023's console registration, and every wire call a surface makes names a method registered by that method's owning plan._

#### The four bars

- **Richness.** The console carries a signature set no single-user chat client has: a live cast of participants with present-tense verbs, a provenance rail that draws the session's shape, session replay at time scale, handoff threads drawn as structure, approval moments that leave visible residue, boundary seams for provider switch, compaction, and rollback, an honest park banner, and an all-clear state. The first sixty seconds and the flagship frame are designed compositions, regression-tested by screenshot.
- **Elegance.** Every surface names its single job and its density budget — what is collapsed by default and what is one click away. No surface carries two visible controls for one act. Attention is steered by luminance and the two-hue rule, never by motion.
- **Zero copy.** Mechanics are adopted from the field; skin, names, and copy are ours. A mechanical sweep against a banned-string list (the reference applications' names, component and store names, and product terms) runs on every console PR and fails on a known-bad input as its negative control before every run.
- **Light on the machine.** Richness is paid for in design, never in RAM or CPU. Nothing polls: every refresh is event-driven through one scheduler with an absolute deadline. Every cap, window, and timeout is a named constant with a one-line rationale, and every subsystem states its memory floor. Heavy work — highlighting, diff compute, graph layout, markdown for long messages — runs off the main thread or lazily, and streaming paints through a bounded reveal budget so four concurrent lanes cost one frame. A library is admitted only after its bytes, heap, and frame cost are measured against an own build, and the budgets below are measured from the first commit.

#### Meridian, the design language

1. **Ledger rows.** Timeline rows are flush-left ledger lines: a 2 px attribution edge in the author's hue, author and timestamp in a fixed gutter, content in a single measure. No bubbles, no left-and-right alternation, no avatars in the flow. The screen reads as a work log because it is one.
2. **The participant hue system.** Each participant, human or sidekick, takes a deterministic hue from a twelve-step OKLCH wheel at fixed lightness and chroma, keyed by a hash of the participant id. The hue answers "who" everywhere — attribution edges, cast-bar rings, typing indicators, pane focus rings, diff-gutter attribution, handoff ticks. Two participants adjacent on the wheel in one session are separated by the next free step. Hues are never used for attention.
3. **The two-hue rule.** Amber means a person is needed. Red means something failed. Nothing else is colored for attention; the brand accent is one desaturated cyan used only on interactive affordances. A view with nothing amber and nothing red is, by construction, a view that needs nobody.
4. **Type and figures.** UI text is a humanist grotesque; every wire-true figure — costs, counts, SHAs, durations, token totals, timestamps — renders in mono, verbatim. Mono is the signature that a number came from the wire; prose never paraphrases a figure. The faces are IBM Plex Sans and IBM Plex Mono, variable builds self-hosted from the foundry packages with the slashed zero and tabular figures enabled.
5. **Motion.** Settles, never bounces: 120–180 ms ease-out, entrances fade with a 2 px rise, zero overshoot in chrome; attribution threads draw with a 240 ms line-grow. Motion is platform-native (CSS transitions, `@starting-style`, View Transitions, the Web Animations API) with an own spring sampler emitting `linear()` easings; no animation library sits on the render path. `prefers-reduced-motion` collapses everything to opacity.
6. **Copy.** Calm authority: sentence case, past-tense receipts, no exclamation marks, no celebration copy. Refusals name the actor and the rule; absences name their kind and their escape hatch. No copy claims a capability the code does not implement, and no copy names a vendor as a product feature.
7. **Density budgets.** Tool rows render as one line until opened; run chapters collapse once terminal and the live chapter stays open; diff cards expand to a height cap and then offer "show all"; the cast bar shows up to eight chips, then "+N"; sidebar sections stay collapsed unless they carry an amber or red item; the inspector shows one entity at a time; settings is two panes, one page at a time; secondary controls live one click away — a row's hover footer or its context menu — never as a second visible button.
8. **Kinds of nothing.** Five absences render differently because the operator's next move differs for each: _not loaded_ (a skeleton in the row's shape), _empty_ (a quiet line with the escape hatch), _error_ (a red-edged row with the code and the daemon's message text), _not checked_ (a dotted badge), and _unknown, still computing_ (a badge with a clock glyph). A renderer that collapses two of these into one is wrong.
9. **The refusal grammar.** Controls are offered; refusals are rendered, in one of three shapes — **inline** on the control that was pressed (the code in mono, the daemon's message verbatim, the next move when one exists), as a **card** in the ledger when the refusal changes history, or as a **banner** across the workspace when it changes what the whole room can do. A refusal never hides the control that produced it and never re-derives the daemon's rule.

**Layout grammar.** The app frame is a thin icon rail beside the session workspace. The workspace is a cast bar on top, the deck of panes below it, and a collapsible session sidebar. Every pane carries an attribution-colored focus ring and an entity breadcrumb with a kind glyph. The inspector is a pane kind, not a fixed third column. The command palette has categories, recents, a scoped-context row naming what the command acts on, and one matcher shared with settings search. Iconography is a single-stroke set (Tabler glyphs compiled at build time) plus our own signature glyphs for participants, runs, and provenance kinds in the same collection.

#### Rules every console surface obeys

- **Absent, not disabled.** A control the caller's role cannot use is not rendered. A control the daemon may refuse is rendered and its refusal is shown; eligibility is never projected by the renderer — the `I-004-24` fail-closed-projection discipline, generalized.
- **Offer, then render the refusal.** The renderer never pre-denies; it calls, and renders the typed refusal code with the daemon's message text and the operator's next move.
- **One accountant.** Every cost figure comes from the committed-spend read surface ([Spec-016 §Cost Figure Display Consistency](016-multi-agent-channels-and-orchestration.md#cost-figure-display-consistency)); the renderer never sums visible rows, never labels a figure a lower bound, never totals across sessions.
- **Write-only credentials.** A credential-bearing input appears on no reply and is never echoed ([ADR-028 §Decision](../decisions/028-provider-credential-custody-posture.md#decision); the Provider Accounts and MCP Servers sketches below).
- **Fail-closed projection.** An unknown enum member renders as the explicit unrecognized row or badge, never as a guess.
- **Wire figures are verbatim.** Roots, SHAs, costs, token counts, and durations render exactly as received, in mono.
- **No interval polling.** Reads happen on subscribe, on window focus, on reconnect, and on the terminal events the owning spec names — through one refresh scheduler firing at `min(lastEvent + delay, firstEvent + maxWait)`, serialized, so a trailing debounce cannot starve under a stream.
- **Reserved, not stubbed.** A capability-gated feature the corpus reserves (realtime voice channels, [ADR-015](../decisions/015-v1-feature-scope-definition.md) feature 23) gets no surface, no placeholder, and no setting until the capability exists.

#### The surface set

- **The icon rail.** Three destinations — sessions, workflows, settings — each a glyph with a text label on hover and in the accessible name, plus an attention count on the sessions destination taken from the daemon's attention projection, never counted in the renderer. Nothing else: no session list inside it, no status text, no branding. Of the eight surface families §Renderer Responsibilities enumerates, four (repo, diff, approval, orchestration) are session-scoped and are reached inside a session through the deck and the sidebar; the invite family spans both scopes — the invites a session sends live in the sidebar's members section, and a **received** invite, which by construction precedes the membership it creates ([Spec-002 §Required Behavior](002-invite-membership-and-presence.md#required-behavior)), is reached from the sessions destination as a shelf above the all-sessions list; the rail names the three top-level contexts and drops no family.
- **The all-sessions list.** One row per session — identity, wire-verbatim `SessionState`, live activity, and the attention severity that applies — in two pin tiers with a visible divider. A session with no name renders by its identifier and participants, never by an invented title, and a lifecycle control whose verb is not registered is not drawn (Plan-023's console growth slate names the missing verbs).
- **The session workspace.** The **cast bar** shows every participant as a live chip — hue ring, name, presence glyph, terminal-lease glyph where held, and a present-tense verb derived client-side from that participant's newest timeline row and liveness alone — up to eight chips then "+N", with an all-clear line when nothing is amber or red. The **deck** holds independent panes, each headed by an entity breadcrumb and a kind glyph, with the actor's hue as the focus ring; one entity opens one pane, structurally (a single mount door and a tripwire that fails on a second). The **session sidebar** shows the session's other work as independently loaded sections — goal, channels, runs, agents, repos and worktrees, approvals, artifacts, members — each a composition of its own read, opening panes; a section carrying an amber or red item is open and every other section is collapsed.
- **The composer** is the shell chrome sketched under §Signature Feature Composition Sketches; it hosts the send router, the target chip, the posture chip, and the discovery-only autocomplete that sketch specifies.
- **Pane kinds, a closed set:** `timeline` (session- or channel-scoped), `inspector`, `runs`, `approvals`, `diff`, `artifact`, `workflow-run`, `workflow-builder`, `browser`, `terminal`, `agent-console`. The sidebar opens any of them; the workflows rail destination opens `workflow-builder`. A repo, workspace, worktree, invite, or member entity is a card in its sidebar section and opens as an `inspector` pane keyed by its entity kind, its changes opening the `diff` pane — no dedicated pane kind exists for those families and the set is not widened for them. A layout snapshot of an unknown version is discarded whole, an unknown pane kind is dropped and reported, and an entity id that fails validation is rejected. Two kinds are built now and wired live only behind their governing amendments: `browser` (a main-process `WebContentsView` beside the renderer; its `browser.*` bridge namespace joins §Preload Bridge Contract, and a Type-2 ADR for the embedded browser subsystem lands, before it goes live — §ADR Triggers) and `terminal` (a lease-gated pane over [Spec-003](./003-runtime-node-attach.md)'s shared-terminal write lease; the renderer surface and its lease obligations join Spec-003 before it goes live). Until then both run against the fixture bridge.
- **Auxiliary windows.** `timeline` and `agent-console` panes can be moved into their own hardened `BrowserWindow` — the two windows §Main Process Responsibilities names — opened from the platform menu bar and from a keybinding. An auxiliary window loads the same renderer bundle at a window route, carries its own preload and bridge instance, subscribes to the daemon itself, and shares no in-memory store and no auth material with the main window; the main window shows the moved pane's slot as a placeholder with a focus control, and a crashed auxiliary window returns the pane to the deck with the crash noted in the pane's error slot. A renderer-initiated detach from a pane rides a window-control bridge namespace on the growth slate; the menu-bar path ships first because it needs no new namespace.
- **Settings and operator pages** are two panes, one page at a time, sharing the palette's matcher for search; the Provider Accounts and Cost page and the MCP Servers page are the operator-plane sketches below, and a Keyboard page offers rebinding with conflict detection over the console's when-scoped chord grammar.
- **Notifications** compose the daemon's attention projection — items grouped by session, actionable split from informational — under [Spec-019](./019-notifications-and-attention-model.md): no dismiss (an item clears when the daemon resolves it), no per-session mute (preferences are global in V1), no re-filtering by preference in the renderer, and OS do-not-disturb honoured by the shell.

#### The fixture bridge

- A bridge provider in the renderer is typed from `packages/contracts`' desktop-bridge types and has two implementations: a **live** bridge wrapping `window.sidekicks`, and a **fixture** bridge serving deterministic scripted scenarios over async generators with time-scaled playback and a frozen clock. Both are shape-identical to §Preload Bridge Contract, namespace for namespace, so a surface cannot tell which it is running on.
- Fixture code — every scenario and the switcher — sits behind the same compile-time `define`-substituted identifier as the smoke probes (§Pitfalls To Avoid), so a release bundle carries none of it; a runtime `process.env` gate is a tripwire failure.
- A scenario manifest names every scenario, its frozen ticks, and, per bridge method, that method's live status at the corpus revision the console was built against, so a surface's live-status claim is checked against the manifest by a test rather than asserted. Scenarios double as demo reels and renderer test data; one — the flagship frame — is the README hero image and the pinned screenshot target.
- The renderer runs in the Electron shell and under plain `vite dev` in a browser, since the fixture seam needs no daemon.

#### Budgets

Named targets, measured from the first console commit, recorded in a dated endurance ledger, and gating every console PR:

| Budget | Target |
| --- | --- |
| Renderer initial bundle | ≤ 450 kB gzip, excluding lazy chunks (terminal, node graph, math, diagrams, browser tools) |
| Frame time, four lanes streaming | p95 ≤ 16.7 ms on the reference machine |
| Renderer heap, one session open at rest | ≤ 120 MB |
| Steady heap, flagship replay | flat over thirty minutes; ≤ 250 MB renderer heap |
| Idle CPU, session open, nothing streaming | ≤ 0.5 % of one core averaged over sixty seconds; no timer fires except the refresh scheduler's deadline and the presence heartbeat |
| Streaming CPU, one lane | ≤ 15 % of one core on the reference machine; the reveal engine yields when the frame budget is spent |
| Terminal instance | ≤ 20 MiB at the default scrollback |
| Time to first ledger row on launch | ≤ 800 ms from window show, fixture mode |

#### Persistence on the renderer scheme

Layout, scroll position, selection, drafts, pins, and expansion sets persist per install; projections never do and are re-derived on reconnect (§Pitfalls To Avoid). That persistence lives in IndexedDB under an own per-session partition with LRU trim and a quota gauge — which exists on the renderer's custom scheme only when the scheme is registered privileged (`standard: true`) before `app.ready` (§Renderer Bundle; Plan-023 I-023-11, shipped by its Tier-1 supplement Phase 1B). Until that registration ships the persistence layer runs on an in-memory adapter and says so.

### WebAuthn Credential Flow

Per ADR-010, WebAuthn PRF is the primary desktop credential path. Electron does not provide platform-authenticator flows natively (see [Implementation Notes §WebAuthn Platform-Authenticator Native Module](#webauthn-platform-authenticator-native-module)), so the main process drives the ceremony through a native-module binding, not through `navigator.credentials.*` in the renderer.

End-to-end flow:

1. Renderer requests sign-in → bridge `webAuthn.getAssertion(options)`
2. Main process invokes the chosen native-module binding against the platform authenticator (Touch ID / Windows Hello / FIDO2 roaming on Linux)
3. Authenticator produces the assertion + PRF output
4. Main process stores the PRF-derived wrapping key in its own address space (never exposed to renderer)
5. Main process uses the wrapping key to unlock the PASETO refresh token from the OS keystore
6. Main process returns only the ceremony success signal + participant identity claims to the renderer
7. Subsequent control-plane calls from the renderer flow through the bridge, where the main process attaches the unwrapped access token + DPoP proof

If the native module is unavailable or the platform authenticator does not support the PRF extension, the flow falls back to the Device Authorization Grant path per §Fallback Behavior.

### Deep-Link Invite Flow

1. OS invokes `sidekicks://invite/<token>` — protocol handler fires in the main process
2. Main process parses the URL and extracts the invite token, holding it in main-process memory only — it does not accept the invite yet, and it does not forward the token to the renderer
3. Main process resolves the display metadata needed to render a confirmation (target session identity, inviter identity) from a **non-consuming** control-plane invite-metadata path — it does **not** decode the opaque token locally (the token is a PASETO `v4.local` envelope it holds no key for; see the pin below), and it does **not** consume the single-use invite to preview it (a preview that burned the `jti` would defeat step 4's confirmation). It then emits a bridge event carrying that metadata plus an opaque invite reference — never the raw token — to the renderer
4. Renderer surfaces an explicit confirmation and waits for the participant to accept; this user-initiated step is required (no auto-accept on protocol fire) so an email scanner, link-preview fetcher, or other automated `sidekicks://` follower cannot silently consume the single-use invite
5. On confirmation, the renderer signals the main process via the opaque reference; the main process calls the control-plane `acceptInvite(token)` procedure with the confined token plus the attached PASETO access token + DPoP proof
6. On success, main process receives the new session membership and notifies the renderer via a bridge event
7. Renderer navigates to the newly joined session view
8. The raw invite token never crosses the bridge to the renderer; the renderer drives confirmation and navigation through the opaque reference and the membership event alone

> **Modern-practice grounding (2026-05).** Two properties are load-bearing, each reflecting current best practice:
>
> - **(a) Token confinement to the main process.** The renderer is an untrusted surface (see [§Trust Stance](#trust-stance) and [ADR-016](../decisions/016-electron-desktop-shell.md)); single-use invite tokens must not be exposed to it, mirroring the WebAuthn/PASETO confinement specified in the [§WebAuthn Credential Flow](#webauthn-credential-flow) above. This matches established Electron guidance that auth material is held and processed in the main process while the preload exposes only narrow IPC surfaces ([Electron deep-link handling](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app); [Better Auth Electron integration](https://better-auth.com/docs/integrations/electron)).
> - **(b) Explicit user confirmation before consumption.** Auto-accepting on protocol fire lets an automated `sidekicks://` follower (email scanner, link-preview fetcher) silently consume the single-use invite; an explicit confirmation step after the app surfaces the invite is the recommended mitigation ([Mastering Magic Link Security](https://guptadeepak.com/mastering-magic-link-security-a-deep-dive-for-developers/); [observed scanner pre-consumption](https://github.com/better-auth/better-auth/discussions/6985)).
>
> The opaque-reference handoff is the mechanism that lets the renderer drive (b) without violating (a). The precise reference data shape, its main-process lifecycle, and its expiry / error semantics are owned by [Plan-023](../plans/023-desktop-shell-and-renderer.md) Tier 8 (the protocol handler + the bridge-event IPC dispatcher); this section pins the flow and these two properties, not the data type.
>
> **Non-consuming invite-metadata path required (pin).** Step 3's "resolve the display metadata" is **not** a local operation. The invite token's payload — `{session_id, inviter_id, join_mode, expires_at, jti}`, the very fields step 3 needs to render the confirmation — is, per [Spec-002 §Token Security Properties](./002-invite-membership-and-presence.md#token-security-properties), "encrypted inside the PASETO v4.local envelope"; the main process holds no decryption key for it (only the control plane does, per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)), so it **cannot** extract the target-session or inviter identity by decoding the token. And the only invite-acceptance surface, `controlPlane.acceptInvite(token)` (step 5), is **consuming** — it burns the single-use `jti` (`Spec-002 §Token Security Properties`) — so it cannot be used to preview. **Decision pinned:** the deep-link flow REQUIRES a control-plane invite-metadata path that is **non-consuming** (does not burn the `jti`) and returns the target-session + inviter identity for the confirmation; the `v4.local` opacity is the constraint that forces it. **Deferred to [Spec-002](./002-invite-membership-and-presence.md) / [Plan-002](../plans/002-invite-membership-and-presence.md):** the procedure's request / response shape, its consumption semantics, and its expiry / error behavior — including whether the desktop path reuses the existing non-consuming link-resolution surface ([Spec-002 §Invite Delivery](./002-invite-membership-and-presence.md#invite-delivery) describes the control-plane web page that validates-and-displays the session name + join mode before the separate acceptance step) or adds a sibling procedure — are owned by the invite spec / plan that own that surface. As with the [§Preload Bridge Contract](#preload-bridge-contract) daemon-subscribe pin, this clarifies the flow and pins the requirement, not the data type. **Resolved 2026-08-11 (BL-133 amendment):** the owning spec chose the sibling-procedure path — [Spec-002 §Interfaces And Contracts](./002-invite-membership-and-presence.md#interfaces-and-contracts) defines `invite.preview`, an anonymous non-consuming POST-only tRPC mutation returning `{sessionId, joinMode, expiresAt, sessionName, inviterDisplayName}` — the target-session identity step 3 renders (restored by PR #322 Codex round 1: V1 has no session-name producer, so an identifier-free response left the confirmation nothing to identify the session by; the raw inviter id stays excluded, `inviterDisplayName` covering that axis once Plan-018 feeds it) — with accept-aligned refusal ordering; Plan-002 builds the control-plane surface (T2.6/T2.7), and the two desktop consuming legs split by transport: the **in-app** invite-accept view rides [Plan-008](../plans/008-control-plane-relay-and-session-join.md)'s Tier-5 invite-acceptance handoff (Plan-002 CP-002-9), while the **deep-link** leg specified here issues the preview over the main process's own control-plane client and never the daemon gateway (Plan-023 CP-023-5) — the confinement step 2 already requires, since a token routed through the daemon has left the main process.

### Auto-Update Flow

1. Main process schedules update checks on a configurable cadence (default: every four hours, additionally on app startup, additionally on user request)
2. On available update: download to a temp location and verify the signature against the bundled update-signing public key
3. Post-verification: stage the update artifact in the platform-appropriate location (`CSIDL_LOCAL_APPDATA` on Windows; `~/Library/Application Support` on macOS; `$XDG_DATA_HOME` on Linux)
4. Notify the renderer via `update.subscribe`; renderer surfaces the "Update ready — restart to apply" UX
5. On restart (user-initiated via bridge `update.requestRestart()` or next natural launch): apply the staged update
6. Post-apply: perform the daemon handshake. If the daemon fails to start or reports an incompatible protocol version, roll back to the previous version and re-surface the update to try again later
7. If signature verification ever fails, discard the artifact, log the event, and re-attempt the download next cycle

Update signature verification must use an Ed25519 or ECDSA-P256 signing key pinned at build time. The public key is embedded in the shell binary and immutable for the lifetime of that binary.

### Daemon Supervision Lifecycle

1. Shell startup: read daemon config (socket path, expected version); probe the existing socket
2. If daemon not running: spawn via `utilityProcess.fork(daemonEntryPath)` (see [Implementation Notes](#utility-process-vs-child-process)); wait for `DaemonHello` readiness signal up to a 10-second timeout
3. If daemon running but version incompatible: surface to renderer; block mutating operations; permit read-only subscriptions
4. Live mode: heartbeat via `DaemonStatusRead` on 30-second cadence; missed heartbeats trigger reconnect probe
5. Daemon crash: detect via `utilityProcess` exit event; restart with backoff; after five failed attempts surface persistent error state
6. Shell shutdown: send `DaemonStop` with a 10-second grace window, then force-terminate

## Default Behavior

- The shell auto-connects to the local daemon at shell startup (starting the daemon if needed, per `Spec-007 §Default Behavior`) and exposes renderer-accessible capabilities via the preload bridge per §Trust Stance; the renderer is not a direct daemon client
- Auto-update is **enabled** by default; user may disable it via settings
- Crash reporting is **enabled** by default with PII-stripping; user may opt out via settings
- Notifications are **enabled** by default; the mute is **global only** — [Spec-019 §Resolved Questions and V1 Scope Decisions](./019-notifications-and-attention-model.md#resolved-questions-and-v1-scope-decisions) keeps notification preferences global in V1 with per-session preferences deferred, so the console offers no per-session mute (corrected 2026-09-01; the prior sentence offered one that spec does not define)
- Deep-link protocol handler registration is performed on first launch

## Fallback Behavior

- If OS-local transport to the daemon is unavailable: fall back to loopback per `Spec-007 §Fallback Behavior`; surface the fallback clearly in the UI
- If the daemon fails to start after five backoff attempts: enter offline read-only mode; surface the error; expose a manual retry
- If the auto-updater cannot reach the feed: skip this cycle; retry on schedule; do not block normal operation
- If WebAuthn is unavailable (authenticator missing, PRF extension unsupported by the platform authenticator): fall back to the CLI-equivalent Device Authorization Grant flow per Security Architecture §Control-Plane Authentication, surfaced as a `localhost:<port>/callback` browser capture
- If the OS keystore is unavailable: refuse to persist long-lived auth material; session is memory-only; surface the degradation

## Interfaces And Contracts

### Renderer → Shell → Daemon (via Preload Bridge)

- Wire format between renderer and shell: Electron IPC over `contextBridge`-exposed functions; serialization via structured clone
- Wire format between shell and daemon: JSON-RPC 2.0 with Content-Length framing per Spec-007 and ADR-009
- The shell is a transparent forwarder for the daemon contract — no method rewriting, only auth-header attachment and response-payload sanitization

### Renderer → Shell → Control Plane (via Preload Bridge)

- Wire format between shell and control plane: tRPC v11 over HTTPS for request/response (incl. relay negotiation); WebSocket (JSON-RPC 2.0) for presence/collaboration events, and the relay WSS connection speaking `Spec-008 §Message Framing` binary wire frames — per ADR-014 and Spec-008
- Shell attaches `Authorization: DPoP <PASETO v4.public>` + `DPoP: <signed-proof>` headers (the RFC 9449 §7.1 scheme for a DPoP-bound token, never `Bearer`) to the tRPC/HTTPS and presence-WebSocket requests; renderer never sees them. **The relay WSS connection is the exception**: it carries no `Authorization`/`DPoP` headers — browsers cannot set custom headers on a WebSocket handshake — and authenticates solely via the R3-issued `connectionToken` presented over two `Sec-WebSocket-Protocol` subprotocol values (`paseto-v4, <base64url(connectionToken)>`), per [Spec-008](008-control-plane-relay-and-session-join.md) §Relay Connection Lifecycle and [Security Architecture](../architecture/security-architecture.md) (§WebSocket authentication to relay). This `connectionToken` is auth material confined to the main process: relay negotiation (`negotiateRelay` → `RelayNegotiationResponse.connectionToken`) runs **main-process-owned** — it is not exposed on the renderer-facing generic `controlPlane.call` forwarder, and the main process consumes the token to open the relay WSS connection, so it never crosses the preload bridge to the untrusted renderer (§Preload Bridge Contract forbidden-surface list; renderer-untrusted §Trust Stance). **A second exception is the anonymous-procedure arm**: header attachment is conditioned on the shell holding a control-plane credential, so a procedure the control plane defines as anonymous is issuable with none at all. `invite.preview` is the V1 instance — anonymous per `Spec-002 §Interfaces And Contracts`, and deliberately excluded from Plan-008's I-008-4 gated-endpoint set because the previewer may hold no registered identity yet — which is precisely what lets a signed-out recipient reach §Deep-Link Invite Flow's confirmation step before authenticating. Anonymous means authentication is not _required_, not that a held credential must be stripped: the procedure is rate-limited per token-hash rather than per principal, so a present credential changes neither admission nor throttling

### Shell ↔ OS Keystore

- macOS: Keychain Services via a native-binding library (see [Implementation Notes §Native Keystore](#native-keystore))
- Windows: Credential Manager via the same abstraction
- Linux: Secret Service (libsecret) with KWallet fallback; if neither available, surface the OS-keystore-unavailable degradation from §Fallback Behavior

### Shell ↔ Auto-Update Feed

- Transport: HTTPS
- Artifact format: platform-appropriate (`.dmg` / `.zip` for macOS, `.exe` NSIS or MSI for Windows, `.AppImage` / `.deb` / `.rpm` for Linux) plus a manifest carrying the artifact hash and signature
- Signature algorithm: Ed25519 (preferred) or ECDSA-P256

## State And Data Implications

- Window state (size, position, maximized) persisted to shell-local config; not sensitive
- Settings (auto-update preference, notification preferences, workspace mounts, the crash-report opt-out, the two node-wide browser switches, and the Invites View's local **Not now** hides — the last five added 2026-09-01) persisted to shell-local config
- Console layout, scroll position, selection, drafts, pins, and expansion sets persisted **per install** in IndexedDB on the privileged renderer scheme (§Console Design (Meridian) §Persistence on the renderer scheme; added 2026-09-01) — never a projection, which is re-derived on reconnect; this is the one renderer-storage tier the shell has, it holds no auth material, and it exists only once the scheme is registered `standard: true` before `app.ready` (Plan-023 I-023-11), the persistence layer running on an in-memory adapter and saying so until then
- Auth material (tokens, keys) persisted to OS keystore; never shell config, never renderer storage — the renderer-scheme tier above is the only renderer storage and is out of bounds for it
- Daemon session token cached in shell memory for the lifetime of the session; rotated on daemon restart per Security Architecture §Session Token
- Supervisor state (daemon PID, last-heartbeat timestamp, restart attempt count) persisted in shell-local state for crash-recovery diagnostic only
- Update artifact cache: shell-owned; cleared after successful apply or after a configurable retention window

## Example Flows

- `Example: First-run onboarding.` The shell starts with no daemon running. The shell launches the daemon as a utility process, waits for `DaemonHello` readiness, and loads the renderer. The renderer displays the first-run three-way-choice onboarding surface (relay selection) per Spec-026 (BL-081). User selects "free public relay". The shell writes the choice to daemon config and forwards the daemon-configured relay URL to the renderer. The renderer displays the sign-in surface.

- `Example: Accept invite via deep link.` User clicks `sidekicks://invite/abc123` in their chat client. The OS dispatches the URL to the registered handler. The shell parses the token and **confines it to the main process** — it is never handed to the renderer. Main issues the **anonymous, non-consuming** `invite.preview` — issuable with no credentials at all, since the recipient may hold none yet — mints an opaque single-use pending reference, and publishes the reference plus display metadata to the renderer. The renderer renders the confirmation surface and the user **explicitly confirms**; only then does main call the authenticated `acceptInvite(token)` with the confined token plus the PASETO access token + DPoP proof. The membership result reaches the renderer as an `invite.subscribeOutcome` bridge event, and the renderer navigates to the joined session view. **There is no auto-accept on protocol fire** — §Deep-Link Invite Flow's property (b) and the acceptance-requires-confirmation invariant it delegates to [Plan-023](../plans/023-desktop-shell-and-renderer.md) Tier 8 (I-023-9) both forbid it.

- `Example: Passkey sign-in.` Renderer calls `bridge.webAuthn.getAssertion({...})`. Shell invokes Electron's WebAuthn binding; the platform authenticator prompts (Touch ID / Windows Hello). Authenticator returns the assertion plus PRF output. Shell derives the refresh-token-wrapping key, unwraps the refresh token from the OS keystore, exchanges it for a fresh access token at the control plane, caches the access token + DPoP key in main-process memory, and returns only the participant identity claims to the renderer.

- `Example: Auto-update applied.` Shell hits the update feed on schedule; finds a new version; downloads and verifies the signature; stages the artifact; emits an `update:ready` event. Renderer surfaces "Update ready — restart to apply." User clicks; shell calls `app.relaunch()` after a graceful daemon shutdown; the new shell launches; the daemon handshake succeeds; the user sees the new version.

- `Example: Daemon crash mid-session.` The session engine process exits abnormally; shell's `utilityProcess` exit handler fires. Shell surfaces "Local runtime disconnected — reconnecting…" to the renderer. Shell restarts the daemon with exponential backoff; on recovery the daemon replays its event log and the renderer resubscribes. User sees the timeline catch up and the session resume.

## Signature Feature Composition Sketches

Each V1 Signature Feature view must compose daemon and control-plane state via the preload bridge. The owning plan listed in parentheses is the canonical source of feature behavior; the renderer is a read-and-steer projection of that behavior, not the source of truth. The section also carries operator-plane views that compose under the identical rule without themselves being Signature Features; each such view says so in its own `Note`, so the Signature Feature enumerations elsewhere in this spec continue to name exactly the features they always did.

### Timeline View — the "everything happens here" surface (→ Plan-013 Live Timeline And Reasoning Surfaces)

- Data sources: daemon event-log subscription (`bridge.daemon.subscribe('session.events', …)` per Spec-013); control-plane presence subscription for participant-state badges
- Renders: chronological event stream (messages, tool calls, approvals, diffs, agent reasoning, interventions, state transitions) per Spec-013
- Interactions: scroll-to-tail, jump-to-event-by-ID, filter-by-participant / event-type, "replay from here" via Spec-015 replay contract, and the per-row edit-and-resend entry point on participant `user.message` rows (placement bullet below)
- Edit-and-resend placement: the entry point for Plan-004's atomic edit-and-resend composite is a hover-revealed pencil affordance in the participant `user.message` row's footer, opening an inline editor with a Cancel action and a confirm action. It is an **entry point to the existing `rollback` control, not a new run control** — the V1 control set stays closed as `Spec-004 §Resolved Questions and V1 Scope Decisions` states it. Its eligibility predicate, three-state visibility (hidden while the activation arm is dormant, disabled without the declared provider capability, disabled-with-stated-reason on transient guard failure), and dim-not-remove in-flight treatment are owned by Plan-004; this view renders that projection and never re-derives it. Confirm-action copy states that the replacement is **queued and sends on the next Resume** — the replacement send is admitted run-bound and is not dispatched, so the run lands `paused`. Plan-004 authors the affordance in its `run-controls/` subtree and Plan-013 mounts it at the row-footer composition point (CP-004-15); neither plan edits the other's subtree
- Input-ask card: an input-kind `driver_ask` renders as an answerable question card in the run's timeline — the ask's prompt, its structured options where the payload carries them, an **unconditional** free-text answer arm, and a countdown displayed from the daemon's stamped `expiresAt` ([Spec-013 §Timeline Entry Types](013-live-timeline-visibility-and-reasoning-surfaces.md#timeline-entry-types), 2026-08-29). A **permission**-kind ask is not rendered here — it normalizes into the approval model and belongs to the Approvals View below, and the `kind` discriminator is what keeps exactly one of the two surfaces rendering any given ask. Answers dispatch through the already-registered `driver.respondToRequest`; the card settles its resolved, expired, and canceled states from the corresponding `driver_ask.*` rows and never from its own countdown reaching zero. Plan-013 owns the card and its states; this view renders that projection
- State handling: live-tailing mode vs historical-browse mode; local projection cache invalidation on daemon reconnect
- Owning plan: Plan-013

### Session Composer — the shell chrome every session view carries (→ Plan-023 Desktop Shell And Renderer)

- Data sources: the driver capability read and the provider command-and-skill enumeration through `bridge.daemon.call(…)`, both node-local and both scoped to the **target agent's** binding ([Spec-005 §The provider command and skill surface](005-provider-driver-contract-and-capabilities.md#the-provider-command-and-skill-surface)); the context-window and rate-limit meter carriers this spec's Plan-013 surfaces already consume
- Renders: the message input, addressed through a **send router** and a **target chip** (2026-09-01) — the router resolves Send to the one wire call the addressed target admits (a new turn through the run-queue create for a session or channel target; a steer through the `steer` intervention for an active run — there is no send verb), with a path label under the input reading _new turn_ or _steer_ from the target run's subscribed state and never predicted, and the target chip names the addressed agent in its hue with its binding clause (driver, model, effort), its paying-account label, and a pending-switch mark, its popover exposing the five provider axes `agent.configUpdate` carries ([Spec-016 §Same-Agent Provider Switch](016-multi-agent-channels-and-orchestration.md#same-agent-provider-switch)) and rendering the mutation's `pending` / `applied` / `degraded` / `failed` disposition in the chip; a **posture chip** rendering the run's stamped execution posture from the `run.running` row's `executionPosture` member where a run exists and, before any run, the words _posture is set by policy at run start_ — a projection of the daemon's stamp and never of a request, because no wire member carries a posture request; the always-visible context-window meter and the rate-limit indicator, both **mounted** here and authored by Plan-013; a command-and-skill autocomplete listing the target agent's own provider commands and skills with each entry's provider-supplied description — a **discovery** surface that shows what the bound provider offers rather than a launcher, per the interaction rule below; and, where the bound driver declares the capability, the participant-triggered compaction control and the output-speed control — the latter rendering the **provider's declared state** and, where the provider supplied one, its reason, beside the value the operator asked for, so a mode the provider's own account or settings gate refused reads as a refusal with a reason rather than as a control that appears to have worked (2026-08-29). The two are separate values from the daemon and the control renders both; it synthesizes neither, and where no declared state has been read it shows the requested value as requested rather than as achieved. Each of the three capability-gated affordances is **absent rather than disabled** where its flag is `false`, on the fail-closed-projection discipline `I-004-24` states — a disabled control asserts the capability exists and is momentarily unavailable, which would be false
- Interactions: send through the router — never with no target and never to a guessed run; an axis change in the target chip's popover, which dispatches `agent.configUpdate` and renders the response's disposition in the chip; the posture chip, which offers no mutation and opens the run's posture detail; the autocomplete's **discovery-only selection**, which is **bound to the target agent** — an entry enumerated under one `(driverName, providerAccountId)` is offerable only in a composer addressed to an agent of that same binding, so a Claude-enumerated command is never listed for a Codex agent, and re-addressing the composer to a different agent re-reads the enumeration rather than filtering the old one. Selecting an entry **inserts nothing into the message box and starts no turn**: it surfaces what the bound provider offers, and V1 sends exactly one enumerated entry — the compaction command, reached through the compaction control below and never through this list ([Spec-005 §The provider command and skill surface](005-provider-driver-contract-and-capabilities.md#the-provider-command-and-skill-surface)). This is not a deferred nicety: text beginning with `/` is refused outright on provider-bound composer paths by [Spec-017 §Command interception — the reserved `/` prefix (C-18)](017-workflow-authoring-and-execution.md#command-interception--the-reserved--prefix-c-18), so an insert-then-send affordance would compose text this shell's own send path rejects. Also: trigger a compaction (one wire call per explicit request, never on a threshold, a timer, or the 80% hint — [Spec-013 §Context Window and Usage Meters](013-live-timeline-visibility-and-reasoning-surfaces.md#context-window-and-usage-meters)); and set the output speed, which is an `agent.configUpdate` mutation applying at a **run** boundary and is therefore acknowledged as pending rather than shown as immediately in effect ([Spec-016 §Same-Agent Provider Switch](016-multi-agent-channels-and-orchestration.md#same-agent-provider-switch))
- State handling: the enumeration is a **live read held for the composer's current target binding and nothing longer** — not persisted, not cached across sessions, and re-read rather than patched when the provider announces its own set changed, which is what keeps the surface from offering a definition the running provider no longer has. Every capability gate is read from the daemon's capability report; the composer derives none of them, and the compaction control's completed state renders only on the daemon's own `usage.context_compacted` row rather than on the call returning
- Owning plan: Plan-023
- Note: shell chrome, not a V1 Signature Feature — it is the composition point the Signature Feature views mount their composer-area affordances into, and its addition leaves the Signature Feature enumerations in §Scope and §Acceptance Criteria naming exactly the features they already named.

### Approvals View (→ Plan-012 Approvals, Permissions, Trust Boundaries)

- Data sources: daemon approval-queue subscription; approval-projection read via `bridge.daemon.call('approval.projectionRead')` per Spec-012 and the Tier-6 approval method-name registry (api-payload-contracts.md — supersedes this view's pre-audit `approvals.listPending` gloss)
- Renders: pending approval cards (category, requesting agent, summary of action, target scope, remembered-rule option); resolved approvals in history view
- Interactions: approve / deny / remember (a `RememberedScope { kind: 'run' | 'session' }` grant with category-derived pattern semantics per `Spec-012 §Default Behavior` and the api-payload-contracts.md Plan-012 wire block), all forwarded to the daemon approval engine
- Owning plan: Plan-012

### Invites View (→ Plan-002 Invite, Membership, Presence)

- Data sources: control-plane `invites.list` procedure; control-plane presence subscription
- Renders: pending sent invites (with expiry + shareable-link copy), received invites (accept, or a local **Not now** hide — [Spec-002](./002-invite-membership-and-presence.md) defines declining as implicit and mints no decline verb, so the hide is renderer-local, persisted to shell-local config, and issues no wire call; corrected 2026-09-01 from "accept / decline"), membership roster per Spec-002
- Interactions: create invite (produces shareable link token); revoke invite; manage membership role (owner-only) per Security Architecture Permission Matrix
- Owning plan: Plan-002

### Runs View (→ Plan-004 Queue, Steer, Pause, Resume)

- Data sources: daemon run-state subscription per Spec-004; daemon queue subscription per Spec-004
- Renders: active runs with live status (queued / running / paused / completed / errored), queue contents, intervention history per Spec-004
- Interactions: pause / resume on active runs (`run.pause` / `run.resume`); steer / interrupt / cancel / **rollback** through the generic `run.intervene` dispatch per `Spec-004 §Interfaces And Contracts` — `rollback` had been missing from this enumeration since the campaign-B2 amendment made it a first-class intervention type (its desktop control gate authored by campaign B9 at Plan-004 T4.2), and is restored here; enqueue (`run.queueCreate`) and cancel-before-admission (`run.queueCancel`) on the queue. **Queue reorder is struck**: `Spec-004 §Resolved Questions and V1 Scope Decisions` defers queue priority overrides for V1, so the pre-audit "dequeue / reorder" gloss named a surface that does not exist — the queue's only V1 removal path is `run.queueCancel`. All forwarded to the daemon run engine per the Run State Machine domain model
- Owning plan: Plan-004

### Multi-Agent Channels View (→ Plan-016 Multi-Agent Channels And Orchestration)

- Data sources: daemon channel roster read via `bridge.daemon.call('channel.rosterRead')` (per-channel state + typed config + arbitration facet) and child-run links via `bridge.daemon.call('orchestration.childRunLinkRead')`, with channel/arbitration lifecycle events consumed as opaque re-read signals through the daemon event subscription — per the Tier-6 Plan-016 method-string registry (api-payload-contracts.md §Plan-016; supersedes this view's pre-audit "daemon channel subscription" gloss, D-016-18)
- Renders: channel roster with per-channel turn-policy + moderation badges from the typed `ChannelConfig` rendered wire-verbatim; round-robin turn-order indicator from the arbitration facet (`state`, `turnPolicy`, unreachable agent/node when paused); child-run links with `linkType`, `internalHelper` differentiation (visually de-emphasized, never ejected), and `visibility: reachable | unreachable`; budget state via `orchestration.budgetRead`. Run-level stop-condition outcomes (`turn_limit`, `budget_exhausted`, `idle_timeout` triggers) render in the Runs View / timeline, not here (Plan-004/Plan-013 surfaces)
- Interactions: create channel (name + create-time `ChannelConfig`); mute / unmute / archive channel via the `channel.*` lifecycle methods (one wire mutation per explicit user action). The pre-audit "mute participant" and "pause channel" interactions are struck — no such wire surface exists in V1 (participant-level mute has no method; arbitration pause is daemon-initiated, not user-initiated); "intervene" on runs belongs to the Plan-004 run-controls surface. The V1 desktop ships **no** `OrchestrationRunCreate` affordance — child runs are created via SDK/CLI and (at Tier 8) Plan-017 workflows; the desktop renders linkage and refusal records (D-016-18)
- Owning plan: Plan-016
- Note: superseded-sketch disposition ratified by the Tier-6 plan-readiness audit (Plan-016 walk, D-016-18) — this view binds to the finalized Spec-016 surface as registered in api-payload-contracts.md §Plan-016.

### Provider Accounts And Cost View (→ Plan-029 Provider Accounts And Credential Homes)

- Data sources: the node-local `providerAccount` wire namespace through `bridge.daemon.call(…)` for the registry read, default selection, and per-account authentication probe result, and the session cost receipt read surface for spend — concrete method names for both are registered in api-payload-contracts.md per [Spec-029 §Interfaces And Contracts](029-provider-accounts-and-credential-homes.md#interfaces-and-contracts) and [Spec-016 §Session Cost Receipt](016-multi-agent-channels-and-orchestration.md#session-cost-receipt)
- Renders: a **provider-management page** in two panes — the account list on the left, the selected account's detail on the right. Each list row carries the operator label, provider, billing-mode chip, health chip, the provider-reported email and organization where a health observation surfaced them, the freshness line ("last checked …"), and a silenced marker where the operator has turned the background observer off for that account — **never credential-home contents, which the renderer neither reads nor receives, and never a token value, which no reply carries**. The detail pane adds the per-`(account, limit)` quota windows, each labeled with its own limit rather than merged, and the re-login-horizon **estimate** rendered as an approximation ("about N days after sign-in") and **omitted rather than fabricated** wherever the daemon reports it as unknown (2026-08-26, [Spec-029](029-provider-accounts-and-credential-homes.md) sign-in and health-observation amendment). Also renders: a run-start account selector pre-set to that provider's default account; and a per-user cost page covering the operator's sessions, listing each session's own receipt figure broken down per account, every figure carrying its account's billing-mode label per [Spec-029 §Billing mode](029-provider-accounts-and-credential-homes.md#billing-mode)
- Interactions: register an account, remove an account, set a provider's default, **correct the label or billing mode, start a brokered sign-in, cancel an in-flight sign-in, supply a non-interactive token, silence or resume the background health observer, probe now, and reset a credential home** — each forwarded to the daemon registry as one wire mutation per explicit user action. A brokered sign-in renders the provider's verification URL and, on a device-code arm, its user code, with cancel available while the attempt is in flight; **completion arrives on the registry subscription and is never inferred from a timer**, and a completion reported successful updates the row only after the daemon's own observation lands ([Spec-029 §Brokered interactive sign-in](029-provider-accounts-and-credential-homes.md#brokered-interactive-sign-in)). The token field is **write-only in the renderer as well as on the wire**: masked on entry, never read back, never held in serializable renderer state a devtools inspection or crash report would capture, and cleared on submit — the wire rule protects the transport, this protects the screen. At run start the view sends an account override **only** when the operator moves the selector off the default, so an untouched selector produces no override member and the daemon's own default resolution stands ([Spec-029 §Selection at run start](029-provider-accounts-and-credential-homes.md#selection-at-run-start)). Previously this list read: register, remove, and set-default; at run start the view sends an account override **only** when the operator moves the selector off the default, so an untouched selector produces no override member and the daemon's own default resolution stands ([Spec-029 §Selection at run start](029-provider-accounts-and-credential-homes.md#selection-at-run-start))
- State handling: every rendered figure is wire-verbatim — no client-side derivation, re-summing, or parallel per-account tally, including on the cross-session page, which renders each session's receipt as its own figure. Until a cross-session read surface is registered in api-payload-contracts.md there is **no** session-spanning total on this page: the renderer does not assemble one from per-session receipts, which is the client-side re-aggregation [Spec-016 §Cost Figure Display Consistency](016-multi-agent-channels-and-orchestration.md#cost-figure-display-consistency) forbids, and no spend table exists for it to read ([Spec-029 §State And Data Implications](029-provider-accounts-and-credential-homes.md#state-and-data-implications)). Should such a surface be registered, its total renders wire-verbatim like every other figure; account-scoped state (authentication probe result, provider quota) is held per account rather than once per provider — and quota per `(account, limit)` rather than per account, since one account may stand against several limits at once — and a reading observed under a superseded credential generation is re-read rather than rendered as current. **The page derives no eligibility of its own**: health, readiness, expiry, and which controls are available are all rendered from what the daemon reports and disabled where it reports nothing, the fail-closed-projection discipline `I-004-24` states for the edit affordance. A page that recomputed any of them would be the surface nothing enforces
- Owning plan: Plan-029
- Note: an operator-plane view, not a V1 Signature Feature — it composes through the same preload bridge under the same read-and-steer rule, and its addition leaves the Signature Feature enumerations in §Scope and §Acceptance Criteria naming exactly the features they already named.

### MCP Servers View — the settings-level governance page (→ Plan-028 MCP Server Configuration And Governance)

- Data sources: the node-local `mcp.*` wire namespace through `bridge.daemon.call(…)` for the server inventory and per-server detail, and `mcp.subscribe` — the live governance stream — as the update channel, so the page refreshes on the daemon's own transitions rather than by polling, which [Spec-028 §Status Observation and Events](028-mcp-server-configuration-and-governance.md#status-observation-and-events) forbids the daemon to do on the providers and which this page must not reintroduce from above. All eleven operations are already registered by Plan-028; this view mints none
- Renders: a settings-level page in two panes — the server list on the left, the selected server's detail on the right. Each list row carries the server name, its provider and configuration scope, the normalized connection status, an enabled marker, and a **trust chip** whose revoked state names the daemon's own reason, including a config-drift auto-revoke, so an operator sees that trust lapsed and why rather than only that it is gone. The detail pane adds the server's tool inventory with each tool's effective idempotency class and whether that class is the native baseline or an operator override, and the base-config hash identity the trust grant is bound to. Configuration content splits three ways on this page rather than being uniformly withheld, because a page that could not show or collect any would have no way to register a server at all. **(1) Operator-authored input the declaration form collects**: transport, command, arguments, URL, timeouts, the required-server marker, and environment-variable and header **names**. **(2) Read-back**, which is exactly the daemon's redacted config view and nothing beyond it — the same non-secret fields, with secret **values** structurally absent — so the page can support an edit workflow without the daemon ever serving credential material ([Spec-028 §Unified Inventory](028-mcp-server-configuration-and-governance.md#unified-inventory)). **(3) Never rendered**: any value the daemon does not serve — environment-variable values, header values, tokens, URL query values — and the page reads no provider config file, which remains the source of truth and the daemon's to read. Credential-bearing values the form does collect are **write-only in the renderer as well as on the wire**, on the Provider Accounts token-field discipline above: masked on entry, never read back, never held in serializable renderer state a devtools inspection or crash report would capture, and cleared on submit. The five governance **event** payloads remain credential-free and content-free by construction, and the page adds nothing to them
- Interactions: add or update a server declaration, remove one, enable or disable one, grant or revoke trust, set or clear a per-tool idempotency-class override, start an OAuth login, and reconnect — each forwarded to the daemon as **one wire mutation per explicit user action**, the same discipline the Multi-Agent Channels and Provider Accounts views state. An OAuth login renders the daemon-returned authorization URL and settles on the daemon's own completion event rather than on a timer or on the browser returning — the same shape a brokered provider sign-in already takes on the Provider Accounts page. That URL is **transient render state and nothing else**: it arrives on the login reply alone, is held only for the life of the attempt, is written to no renderer storage and no log, and is dropped at settlement — the write-only discipline this page already applies to a credential-bearing form value, applied to a value that is a one-shot launch handle rather than a credential. It is admitted to the renderer as the daemon's own reply value rather than as renderer-composed input, which is the distinction the external-open path exists to police. The prohibition it does not touch is the one that matters: tokens, authorization codes, and PKCE material reach this page on no surface at all. A refusal renders the daemon's typed reason verbatim — a safety-weakening override on an untrusted server is refused before any write, and the page shows that refusal rather than pre-filtering the control, so the operator learns the rule from the system that enforces it
- State handling: every rendered value is wire-verbatim, and **the page derives no state of its own** — connection status, trust state (including a config-drift auto-revoke and its reason), enablement, tool overrides, and effective idempotency class are all rendered from what the daemon reports, the fail-closed-projection discipline `I-004-24` states for the edit affordance. A page that recomputed trust or effective class would be a second source of truth for exactly the decisions [Spec-015](015-persistence-recovery-and-replay.md) recovery depends on. **Eligibility is a separate question and this page does not project it at all**: no inventory field reports whether an operation would be permitted, so every control is offered, the daemon adjudicates, and its typed refusal renders — which is the same rule as the no-pre-filtering interaction above rather than a second one. The one non-offer is a control whose required input is **structurally absent** from the entry the daemon served — on the degraded arm the daemon serves when the trust store is unreachable, the trust state, config-hash identity, and per-tool overrides are absent outright and the enabled marker survives only where the provider itself declares it, so the trust and per-tool controls have nothing to act on while every control whose input did arrive is offered as usual — and that is absence of data, not a judgment the renderer formed. Status arriving on the subscription is applied to the row it names rather than triggering a whole-inventory re-read
- Owning plan: Plan-028
- Note: an operator-plane view, not a V1 Signature Feature — it composes through the same preload bridge under the same read-and-steer rule, and its addition leaves the Signature Feature enumerations in §Scope and §Acceptance Criteria naming exactly the features they already named.

## Implementation Notes

_This section captures architecture-relevant, non-normative implementation guidance. It will be expanded with primary-source citations from the current-state Electron ecosystem research once the research pass completes; see References §Research Conducted._

### Electron Version And Support Window

**Updated 2026-09-01.** Electron 41 reached end-of-support on 2026-08-25 with the release of Electron 44.0.0 (Chromium 152.0.7977.54, Node 24.18.1); the supported majors are 44 / 43 / 42. V1 builds target **Electron 44.x** — 44.1.1 at authoring — and [ADR-016 §Decision](../decisions/016-electron-desktop-shell.md#decision) now carries the 42 / 43 / 44 supported-branch subset of the GHSA-3c8v-cfp5-9885 floors. Two facts of that line the console depends on: the detached-`WebContentsView` bounds fix (electron/electron PR #53031, closing #43257) was backported to 42 / 43 / 44 only, so the `browser` pane kind is not buildable on 41; and the Electron 40 renderer-clipboard deprecation stays enforced through §Renderer Bundle. One dependency rides the floor: Electron 44 is Node ABI 149, which no `better-sqlite3` 12.x release ships a prebuild for, so the daemon's binding moves to the 13.x Node-API line before or with the pin ([ADR-022 §Decision Log](../decisions/022-v1-toolchain-selection.md#decision-log), 2026-09-01). The paragraphs below are the 2026-04-17 record, kept as provenance for the floor derivation.

V1 builds must target **Electron 41.x** (stable release 2026-03-10, Chromium 146.0.7680.65, V8 14.6, Node v24.14.0) at minimum patch version **41.1.0** to pick up the Q1 2026 high-severity CVE batch (CVE-2026-34769, -34770, -34771, -34772, -34774, -34764, all fixed 2026-04-02 in 39.8.5 / 40.8.5 / 41.1.0). 41.1.0 also subsumes the earlier [CVE-2026-34776](https://nvd.nist.gov/vuln/detail/CVE-2026-34776) fix ([GHSA-3c8v-cfp5-9885](https://github.com/electron/electron/security/advisories/GHSA-3c8v-cfp5-9885), out-of-bounds heap read in `requestSingleInstanceLock()` second-instance IPC parser on macOS and Linux; shipped in 41.0.0), whose per-branch floors are the source-of-truth in [ADR-016 §Decision](../decisions/016-electron-desktop-shell.md#decision). Electron 42 is scheduled for 2026-05-05; by V1 GA the target is expected to be Electron 42.x.

Electron has **no LTS lane**. The project team supports the latest three stable majors on an 8-week release cadence aligned with Chromium's 4-week stable channel. Support windows as of 2026-04-17:

- Electron 37: EOL 2026-01-13
- Electron 38: EOL 2026-03-10
- Electron 39: EOL 2026-05-05
- Electron 40: EOL 2026-06-30
- Electron 41: EOL 2026-08-25

**Consequence:** Plan-023 must budget two forced major-version upgrades in V1's first year after ship. Same-week patch adoption is required on security-advisory drops. This is the single largest recurring operational cost of choosing Electron and is accepted per ADR-016; Plan-023 must include release-engineering capacity for the cadence.

Sources:

- [Electron release timeline](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
- [Release schedule](https://releases.electronjs.org/schedule)
- [Electron 41.0 release notes](https://www.electronjs.org/blog/electron-41-0)
- [GitHub Security Advisories, electron/electron](https://github.com/electron/electron/security/advisories)

### Electron Fuses

Electron Fuses are build-time toggles on the shipped binary that harden the binary against misuse as a generic Node runtime or against injection vectors. The posture declared above (RunAsNode disabled, NodeOptions disabled, CLI inspect disabled, asar integrity enabled, OnlyLoadAppFromAsar enabled, cookie encryption enabled) matches the current Electron-documented production hardening recommendation and the posture VS Code, Slack, and 1Password ship with.

### Utility Process Vs Child Process

The shell supervises the daemon via `utilityProcess.fork()` (introduced in Electron 22; production-ready since Electron 24) rather than raw `child_process.fork()`. `utilityProcess` is Chromium-Services-backed (not Node's native `child_process`), which gives the daemon:

- an isolated V8 instance
- MessagePort-based IPC with `MessagePortMain` transfer via `postMessage(msg, [transfer])` — survives across process boundaries
- exit-event propagation the shell can hook for crash recovery
- integration with Electron's Crashpad reporting pipeline
- participation in the shell's structured-clone IPC

The daemon does not inherit the shell's Chromium command-line flags or memory pressure. `utilityProcess.fork()` must be called after `app.ready`.

Exit-reason handling: as of Electron 40, `utilityProcess` exits may carry the reason `"memory-eviction"` — this is the OS reclaiming memory from a backgrounded process, not a crash. Supervisor logic must treat `"memory-eviction"` distinctly from crash reasons (restart with the standard backoff, but without incrementing the failure counter that feeds the "five-attempts-then-surface-error" rule in §Daemon Supervision Lifecycle).

Gotcha: `utilityProcess` has no direct network-interception API equivalent to a renderer's `session` object. If the daemon needs Electron's network stack (for cert pinning, for example), requests must proxy back through the shell main process. If the daemon is content with Node's native `https`, this is moot.

Sources:

- [Electron utilityProcess API](https://www.electronjs.org/docs/latest/api/utility-process)
- [Electron 40.0 release notes](https://www.electronjs.org/blog/electron-40-0) — `"memory-eviction"` exit reason
- [Electron Message Ports tutorial](https://www.electronjs.org/docs/latest/tutorial/message-ports)

### Native Keystore

`node-keytar` was archived by its maintainers on 2022-12-15 (last release v7.9.0, 2022-02-17) and is **not** a supported dependency for new projects. The 2026 replacement adopted by this project is **`@napi-rs/keyring`** (v1.2.0, 2025-09-02 — a napi-rs Rust binding to the `keyring-rs` crate, self-described as a "100% compatible node-keytar alternative"). It supports macOS Keychain, Windows Credential Manager, and Linux Secret Service. It does **not** require libsecret on Linux (it uses `secret-service-rs`), which matters in headless CI, WSL, and Codespaces environments. It is also the replacement path used by the Microsoft Authentication Library for JS and the Azure Identity SDK.

For simple encrypt-one-blob use cases (e.g., small settings values), Electron's main-process `safeStorage` API is acceptable. `safeStorage` uses Keychain on macOS, DPAPI on Windows, and Secret Service / kwallet / libsecret on Linux. Exposed methods: `isEncryptionAvailable`, `encryptString`, `decryptString`, `getSelectedStorageBackend` (Linux only).

**Critical Linux gotcha for V1:** When no OS keystore is available, `safeStorage` silently falls back to a **hardcoded plaintext password** — i.e., secrets are unprotected. This is explicit in the Electron docs. For AI Sidekicks, which holds PASETO refresh tokens, DPoP keys, and WebAuthn PRF-derived wrapping material, the shell must:

1. Call `safeStorage.isEncryptionAvailable()` at startup
2. On Linux, additionally call `safeStorage.getSelectedStorageBackend()` and reject the values `'basic_text'` and `'unknown'`
3. On a non-protective backend, **refuse to persist long-lived auth material** — degrade to memory-only session per §Fallback Behavior, and surface the degradation prominently

The same rule applies to `@napi-rs/keyring` on headless Linux without Secret Service: the abstraction layer must detect the no-keystore case and refuse to persist auth material rather than silently falling back.

Sources:

- [`node-keytar` archive notice](https://github.com/atom/node-keytar) — "archived by the owner on Dec 15, 2022"
- [`@napi-rs/keyring` v1.2.0](https://www.npmjs.com/package/@napi-rs/keyring)
- [MSAL JS keytar migration issue](https://github.com/AzureAD/microsoft-authentication-library-for-js/issues/7170) — corroborating MSAL's move off keytar
- [Electron `safeStorage` API](https://www.electronjs.org/docs/latest/api/safe-storage) — explicit Linux plaintext-fallback behavior

### Build And Packaging

`electron-builder` v26.9.0 (released 2026-04-14) is the packaging tool for V1 — re-pinned 2026-09-01 to the **26.15.x** line (26.15.3 is the registry `latest`, 2026-06-09; 26.15.7, 2026-07-18, sits under the `v26` dist-tag). Multi-platform coverage: macOS `.dmg` and `.zip`, Windows NSIS and MSI, Linux `.AppImage` / `.deb` / `.rpm` / Snap / Flatpak. Reasoning: cross-platform installer-format coverage is broader than Electron Forge's, production-proven at the scale of VS Code / 1Password / Slack, and integrates cleanly with `electron-updater` for the update path on all three platforms.

**Alternative considered:** Electron Forge. Forge v7.11.1 (2026-01-12) is the Electron team's officially-maintained packaging tool, and the electronjs.org docs recommend it as the default. Forge v8.0.0 (the ESM release) is still in alpha as of 2026-04-10; the Forge README explicitly directs production users to v7.x. Forge wins on "closer to Electron's official cadence and less third-party surface." It loses on auto-update: Forge requires wiring `update.electronjs.org` or a custom updater, neither of which covers Linux at all.

Decision: `electron-builder` wins for this spec because cross-platform auto-update on macOS + Windows + Linux is a V1 requirement (see §Auto-Updater below). Plan-023 must pin to `electron-builder` v26.15.x minor versions (re-derived 2026-09-01) and review the changelog on every bump (electron-builder is outside "official Electron support," per the Electron docs).

**Reproducibility limit:** Neither `electron-builder` nor Electron Forge guarantees bit-reproducible binaries out of the box. No primary source found in the 2026-04 research pass claims Electron apps can be bit-reproducibly built today. If Spec-023 needs reproducibility (supply-chain verification, for example), Plan-023 must architect supporting infrastructure (SOURCE_DATE_EPOCH, deterministic filesystem ordering, stripped metadata). V1 does **not** claim reproducible builds; this is an accepted scope gap to revisit in V1.1.

Sources:

- [electron-builder releases — v26.15.x line (re-pinned 2026-09-01 from v26.9.0)](https://github.com/electron-userland/electron-builder/releases)
- [Electron Forge v7.11.1 / v8.0.0-alpha](https://github.com/electron/forge)
- [Electron Forge overview](https://www.electronjs.org/docs/latest/tutorial/forge-overview)
- [electron.build](https://www.electron.build)

### Auto-Updater

`electron-updater` v6.8.4 (released 2026-04-14, part of the `electron-builder` project) drives the auto-update flow — re-pinned 2026-09-01 to **6.8.9** (2026-06-05), the registry `latest`; the manifest schema (`sha512` per-file entries) Plan-023's trust chain binds to is unchanged across the line. Code-signature validation on **both macOS and Windows**. Staged rollouts (0–100% gradual) supported. Squirrel.Windows is explicitly unsupported and must not be used.

Update feed hosting: project-operated static artifact store (S3-backed) with an Ed25519-signed manifest. Update signing key is distinct from the code-signing certificate and is rotated on a documented schedule.

**Delta update posture:** `electron-updater` ships block-map-based differential updates on Windows/NSIS only. macOS DMGs and Linux AppImages download full payloads. Plan-023 must budget bandwidth accordingly (this is a material difference from browser-style delta updates and should not be assumed).

**Rollback absence:** Neither `electron-updater` nor Electron's built-in `autoUpdater` module ships automatic rollback on failed update. The "Update Flow" requirement of this spec (roll back on signature-verification failure or post-install daemon-handshake failure) is **architecture we must build**, not an out-of-box feature. Plan-023 must include the rollback state machine (prior-version artifact retention, launcher-based version selection, or a dual-slot approach) as a first-class component.

**MSIX (Windows Store) path:** Electron 41 added MSIX auto-updating via the same JSON response format as Squirrel.Mac (per Electron RFC #21). Not required for V1 (V1 ships NSIS / MSI installers direct-download). Re-evaluate MSIX for V1.1 if Windows Store distribution becomes a target.

**Alternative (not chosen):** Electron's built-in `autoUpdater` module uses Squirrel.Mac on macOS and Squirrel.Windows (or MSIX updater, auto-detected) on Windows; it has **no built-in Linux support**. The hosted `update.electronjs.org` service is restricted to public GitHub repos, macOS (DMG) + Windows (NSIS) only, and requires signed macOS builds. Neither covers V1's Linux requirement.

Sources:

- [electron-updater v6.8.9 release (re-pinned 2026-09-01 from v6.8.4)](https://github.com/electron-userland/electron-builder/releases)
- [electron-updater documentation](https://www.electron.build/auto-update)
- [Electron built-in autoUpdater API](https://www.electronjs.org/docs/latest/api/auto-updater)
- [update.electronjs.org](https://github.com/electron/update.electronjs.org)
- [Electron 41 MSIX auto-updating](https://www.electronjs.org/blog/electron-41-0)

### Code Signing And Notarization

**Major 2026 change — CA/Browser Forum Ballot CSC-31 (effective 2026-03-01, per [CSCBR v3.10.0 §6.3.2](https://cabforum.org/uploads/CA-Browser-Forum-CSCBR-3.10.0.pdf)):** All publicly-trusted code-signing certificates issued on or after 2026-03-01 have a maximum validity of **460 days** (≈14 months), down from the prior 39-month cap. EV and non-EV certs are both affected uniformly. Hardware-token holders must physically rekey every ≤14 months (≤460 days) rather than every 3 years (literal "15 months" can equal 456–465 days depending on month lengths and may exceed the cap). This reshapes the vendor-cost calculus and makes per-month subscription signing services competitive with EV-cert purchases for small/mid-tier publishers.

#### macOS

- **Identity:** Apple Developer ID Application certificate, issued free under the $99/year Apple Developer Program membership.
- **Process:** Hardened runtime enabled + Apple notarization via `xcrun notarytool` (the `altool` command has been deprecated since 2023-11-01 and must not be used) + `xcrun stapler` to attach the notarization ticket to the artifact so it works offline.
- **Entitlements:** The hardened runtime must declare only what the shell needs. V8/JIT commonly requires `com.apple.security.cs.allow-unsigned-executable-memory` and `com.apple.security.cs.allow-jit`; dynamic loading of native modules may require `com.apple.security.cs.allow-dyld-environment-variables`; keystore access uses `keychain-access-groups`.
- **Operational risk (Jan 2026+):** Apple's notarization queues have been experiencing delays of 24–120+ hours per active developer-forum threads. Plan-023's release pipeline must include **timeout + retry** logic rather than synchronous blocking on notarization.

#### Windows

- **Primary path:** **Azure Artifact Signing** (renamed from "Azure Trusted Signing" when it went **GA on 2026-01-12**), Basic SKU $9.99/month (5,000 signatures, 1 certificate profile). FIPS 140-2 Level 3 HSM-backed, zero-touch cert lifecycle, no hardware token, no EV-cert purchase. Chains to a CA in the Microsoft Trusted Root Program — recommended path for Smart App Control friendliness.
  - **Eligibility gate:** Public Trust is available to organizations in **USA, Canada, EU, UK** and to **individual developers in USA and Canada only**. Outside those regions, Artifact Signing is not available for public-trust signing and this project must use a traditional EV cert. Per-deployment decision; confirm eligibility before locking in.
  - **Does not issue EV certificates.** If distribution requires EV (e.g., for instant SmartScreen reputation), Artifact Signing is not sufficient and a traditional EV cert from DigiCert / Sectigo / SSL.com is required in addition.
- **Alternative $0 OSS path:** [SignPath Foundation](https://signpath.org) sponsorship issues a Standard OV signing cert under publisher attribution "SignPath Foundation" (UX trade-off against own-branding — end users see "SignPath Foundation" not "AI Sidekicks" in the publisher field). Per [Microsoft Learn code-signing-options 2026-04-20](https://learn.microsoft.com/en-us/windows/win32/seccrypto/cryptography-tools), SignPath is the sole Microsoft-recommended OSS-sponsored path (OSSign.org intake is suspended). Eligibility: OSI license + active maintenance + MFA on maintainer GitHub account + published code-signing-policy page on the project site. Turnaround SLA not published by Microsoft or SignPath; third-party reports indicate 2–4 weeks at procurement time.
- **Fallback path:** EV code-signing cert from DigiCert / Sectigo / SSL.com. Typical OV pricing $300–$700/year; EV pricing $400–$1,200/year. Under [CSCBR v3.10.0 §6.3.2](https://cabforum.org/uploads/CA-Browser-Forum-CSCBR-3.10.0.pdf) (CSC-31, effective 2026-03-01), renewal is now every ≤14 months (≤460 days) rather than 3 years — factor this into vendor comparison vs. Artifact Signing's monthly subscription.
- **Smart App Control reality:** Valid code signing is **not sufficient** for Smart App Control to allow a binary. SAC evaluates cert trust chain _and_ cloud reputation (Intelligent Security Graph). New binaries with low distribution get blocked until reputation builds, even with a valid EV signature. First-launch UX on Windows 11 will be rough until reputation accumulates; mitigation is Artifact Signing's Public Trust chain + clear user-facing "Run anyway" instructions.
- **Windows 10 EOL:** Windows 10 reached end-of-support on 2025-10-14. Per `Spec-023 §Scope`, V1 supports Windows 10 + 11 (x64). Because Windows 10 is EOL, this spec accepts the security-posture implication of shipping to an EOL OS for V1. Plan-023 must surface this as a known-state item; a V1.1 decision may tighten to Windows 11 only.

#### Linux

There is no universal code-signing model for Linux. Three distinct formats, three distinct signing mechanisms:

- **`.AppImage`** — optional embedded GPG signature (rarely verified by users); this project additionally publishes the artifact hash alongside the download.
- **`.deb` / `.rpm`** — GPG-sign the package with the project's release key; publish the public key for repositories.
- **Snap / Flatpak** — Canonical signs Snap artifacts on your behalf at the Snap Store; Flathub signs Flatpak artifacts at publication.

`electron-builder` supports all of the above. No automatic signing beyond what each format specifies.

Sources:

- [CA/Browser Forum CSC-31 ballot](https://cabforum.org/working-groups/code-signing/requirements/)
- [Microsoft — Azure Artifact Signing GA announcement (2026-01-12)](https://techcommunity.microsoft.com/blog/microsoft-security-blog/simplifying-code-signing-for-windows-apps-artifact-signing-ga/4482789)
- [Azure Artifact Signing FAQ — eligibility & EV scope](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)
- [Apple Developer ID](https://developer.apple.com/developer-id/)
- [Apple Developer forum — notarization queue delays](https://developer.apple.com/forums/thread/813441)
- [Windows 10 lifecycle](https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro)

### Crash Reporting

Electron's built-in `crashReporter` module uses **Crashpad** (not Breakpad as older docs suggest). It automatically covers main, renderer, Node `child_process`, and `utilityProcess` crashes. Payloads upload as `multipart/form-data` POST (minidump + metadata — version, platform, process type, custom params with key ≤39 bytes, value ≤127 bytes). Compression has been enabled by default since Electron 12.

**V1 sink choice — deferred to a follow-up decision:**

- **Option A — Sentry Electron SDK.** Production-grade symbolication, issue grouping, release tracking, per-process initialization (`@sentry/electron/main`, `/renderer`, `/utility`). Lower operational burden. Cost: third-party dependency holding minidumps.
- **Option B — Self-hosted symbolication.** Project-operated minidump sink. Higher operational burden. Benefit: no third party sees crash payloads.

**Critical PII rule (applies to both options):** Minidumps contain process heap memory, which for this shell contains PASETO tokens, DPoP keys, WebAuthn PRF output, OAuth bearer headers, and daemon session tokens. Uploading unfiltered minidumps to a third party is a data-exfiltration vector. V1 must:

1. Configure `crashReporter.start({ uploadToServer: true, ... })` only after initializing `beforeSend`-equivalent scrubbers (Sentry's `beforeSend` / `denyUrls` / `ignoreErrors` hooks, or equivalent pre-upload scrub for the self-hosted path).
2. Strip session IDs → stable hashes; file paths → extension-only; user messages and agent reasoning payloads → elided.
3. For the self-hosted path, keep the sink inside the same security boundary as the control plane.

Final sink decision is a BL-to-be-filed and owned by Plan-023; this spec declares the requirements the choice must satisfy.

Sources:

- [Electron `crashReporter` API (Crashpad)](https://www.electronjs.org/docs/latest/api/crash-reporter)
- [Sentry Electron SDK documentation](https://docs.sentry.io/platforms/javascript/guides/electron/)

### WebAuthn Platform-Authenticator Native Module

Electron does **not** provide native platform-authenticator WebAuthn prompts on macOS, Windows, or Linux out of the box, despite the underlying Chromium supporting them. The canonical open issues ([electron/electron #15404](https://github.com/electron/electron/issues/15404), [#24573](https://github.com/electron/electron/issues/24573)) remain open as of 2026-04. Additionally, Chromium 146 (shipped in Electron 41) **removed** the `web-authentication-new-passkey-ui` flag that was an earlier workaround — any code path relying on that flag breaks on Electron 41+.

V1 therefore depends on a **native module** to bridge the platform authenticator to the WebAuthn ceremony. Candidates:

- **`electron-webauthn-mac`** (open-sourced by Vault12 in January 2026) — uses Apple `AuthenticationServices` to bridge WebAuthn / passkeys to Touch ID and iCloud Keychain on macOS. [GitHub](https://github.com/vault12/electron-webauthn-mac).
- **`@electron-webauthn/native`** — published as cross-platform, but the research pass could not confirm platform coverage beyond the marketing claim. [npm](https://www.npmjs.com/package/@electron-webauthn/native).

**Required Plan-023 work before lock-in:** Prototype platform-authenticator flows on all three target OSes and confirm:

1. Touch ID works via the Vault12 module on macOS arm64 + x64.
2. Windows Hello works on Windows 10 + 11 via the chosen cross-platform module.
3. FIDO2 roaming authenticators (and, where available, platform authenticators) work on Linux.

If the cross-platform module fails (2) or (3), V1 must either pick a different module or accept the Device Authorization Grant fallback as the Windows/Linux path (per §Fallback Behavior). The prototype's outcome is an open question for V1 (see §Open Questions).

### Console Libraries

_Added 2026-09-01. Every console axis names the libraries considered, the evidence, and the verdict — ADOPT · ADOPT-with-constraints · OWN-BUILD · AVOID — under one rule: a well-maintained library that cuts code we would otherwise write is adopted only where it leaves the visuals, the product requirements, speed, and memory untouched. Citations per axis are in §References §Console Design Research Pass (2026-09-01). Versions are the registry `latest` at authoring and are exact-pinned in `apps/desktop/package.json`; a bump is a lane-3 change that re-reads the row._

| Axis | Verdict | Constraints and reason |
| --- | --- | --- |
| Timeline virtualization | ADOPT-with-constraints `@tanstack/react-virtual` 3.14.10 | Headless, 7.6 kB gzip, the only candidate whose scroller we own (`getScrollElement`, `scrollToFn`, `observeElementOffset`); no smooth `scrollToIndex`, stable keys, direct DOM updates. The reading anchor, follow, and window-cap controller is own-build (no library has a sub-row reading anchor). Chromium caps element height at 33,554,431 px, so the window cap is a ceiling, not a nicety. AVOID virtua (internal scroll writes), react-virtuoso (not headless), react-window, react-virtualized. |
| Streaming markdown | ADOPT micromark + `mdast-util-from-markdown` with GFM; ADOPT-with-constraints remend (tail only); OWN-BUILD the delta-fed block segmenter, the mdast-to-React mapper, the reveal router, and the footnote registry | Whole-message re-parse per token is quadratic; settled blocks parse once with a two-block settle lag; `html` nodes render as literal text, so no sanitizer is on the path. AVOID react-markdown, the rehype stack, markdown-it, markdown-to-jsx, and every Tailwind-styled streaming renderer (styling identity leakage, raw HTML rendering, whole-message re-lex). |
| Syntax highlighting | ADOPT-with-constraints `shiki/core` with the JavaScript engine and lazy grammars; ADOPT `@shikijs/stream` as tokenizer only | One instance per renderer process, in a Worker above about 4 kB of source, byte-bounded token cache, own theme JSON from Meridian tokens, own span renderer; never the preset bundles, never the WebAssembly engine in the renderer (its linear memory grows to about 29 MB and is never reclaimed). AVOID react-shiki, highlight.js, the prism family, sugar-high, starry-night. |
| Math and diagrams | ADOPT-with-constraints KaTeX (lazy, settled blocks only, `trust: false`, MathML output first); mermaid opt-in, lazy, strict, user-triggered | No direct DOMPurify dependency. |
| Terminal | ADOPT-with-constraints `@xterm/xterm` 6.0.0 with the WebGL, fit, search, unicode11, and serialize addons; OWN-BUILD the React wrapper and the renderer pool | Pool WebGL panes and never churn the addon (a disposed WebGL addon does not release its context, and Chromium drops the oldest context past sixteen); `onContextLoss` falls back to DOM; `allowProposedApi` only for Unicode 11; own link provider with the nonce guard; `disableStdin` plus wire-level gating for watchers. AVOID every published React wrapper and the canvas addon. |
| ANSI in ledger rows | ADOPT `anser` (`ansiToJson` only); own span mapper | JSON chunks mapped to Meridian tokens; never an HTML-string path. AVOID ansi-to-react, ansi-to-html. |
| Electron runtime | ADOPT Electron 44.x | Electron 41 is end-of-life; the `WebContentsView` detached-bounds fix landed on 42 and later only (§Electron Version And Support Window). |
| Native browser view | ADOPT `WebContentsView`; OWN-BUILD the bounds bridge, the airspace policy (hide the view and swap in a `capturePage` image while an overlay is open), focus hand-off, and a `devtools-protocol`-typed `webContents.debugger` wrapper | Bounds scale by `webContents.getZoomFactor()`; the pane is a native view, never an iframe (`frame-src 'none'` stands). Wired live only behind the embedded-browser ADR (§ADR Triggers). |
| Browser tool set | OWN-BUILD the tool handlers on `webContents.debugger` with `devtools-protocol` types, served through the existing [Spec-005](./005-provider-driver-contract-and-capabilities.md) callback-tool host, so no MCP server process, SDK, socket, or stdio shim is added | A browser tool call is relayed daemon-to-desktop and answered by Electron main; the relay is a growth-slate wire. AVOID the published browser-automation MCP servers (alpha pins, whole-app CDP exposure, Electron unsupported) for the shipped tool. |
| Packaging and update | ADOPT `electron-builder` 26.15.x and `electron-updater` 6.8.9 (§Build And Packaging, §Auto-Updater) | AVOID update-electron-app, the built-in `autoUpdater` alone, Electron Forge. |
| Main-process storage and logging | OWN-BUILD the settings file (atomic rename, Zod parse, fail-closed defaults) and a JSONL logger; ADOPT-with-constraints `safeStorage` for non-credential blobs; ADOPT `@electron/fuses` | AVOID electron-store, electron-log. |
| Tests | ADOPT-with-constraints Vitest browser mode via `@vitest/browser-playwright`; ADOPT `@playwright/test`, `@testing-library/react`, knip, memlab; ADOPT-with-constraints size-limit; ADOPT `@axe-core/playwright` as a test-only devDependency | `axe-core` is MPL-2.0 — outside the project's MIT / Apache / BSD / ISC dependency norm — and is admitted for a never-distributed test dependency only, recorded in [ADR-020 §Decision Log](../decisions/020-v1-deployment-model-and-oss-license.md#decision-log). AVOID jsdom, lost-pixel (archived), hosted visual-regression services, msw. |
| Diff viewer | ADOPT `diff` 9.0.0 (jsdiff, BSD-3-Clause) for parse and intraline compute; OWN-BUILD one shared virtualized diff-row renderer for inline cards and the pane, with worker-side highlighting | No candidate is both headless and virtualized. jsdiff parses an 898 kB patch in 2.1 ms; line diffs above about 2,000 lines run off-thread; highlighting tokenizes hunk lines only, in the worker (10,000 TypeScript lines on the main thread cost 1,960 ms and 84.5 MB of heap). AVOID the highlight.js-bundling diff viewers (315 kB gzip), diff2html, react-diff-viewer-continued, `@codemirror/merge`, monaco, diff-match-patch (archived). |
| Node-graph builder | ADOPT-with-constraints `@xyflow/react` 12.11.6 ([ADR-026 §Decision](../decisions/026-visual-node-graph-workflow-authoring.md#decision) holds); OWN-BUILD the layered auto-layout, node and edge visuals, inspector, keyboard connect mode, layout persistence | MIT; 59.4 kB gzip plus the required 13.6 kB `base.css` whose 41 tokens are all set from Meridian; 9.1 MB heap and 60 fps drag at 200 nodes. Exact-pin 12.11.x with `@xyflow/system` in lockstep (12.11.4 shipped broken); never alias `zustand`; `isValidConnection` is not applied by `addEdges`, so every programmatic and keyboard edge path calls the same predicate. Own layout: deterministic across processes, 0.3 ms per 200 nodes, zero dependencies. AVOID elkjs (EPL / GPL, 440 kB), dagre 0.8.5, d3-dag, graphology. |
| Layout, panes, drag | ADOPT-with-constraints `react-resizable-panels` 4.12.3 for the deck and `@atlaskit/pragmatic-drag-and-drop` 3.1.0 for drag; OWN-BUILD the deck store, separator chrome, drop indicators, keyboard and menu reorder paths, live-region strings, native-pane rect tracking, and toasts | Panels: MIT, 11.7 kB gzip, no CSS, ARIA window-splitter with keyboard; store-owned layout; pin or patch the open ARIA min/max swap on three-plus pane groups. Drag: Apache-2.0, headless, native HTML5 drag so no per-frame renders; it provides no keyboard drag by design, so the menu and chord paths are ours. AVOID dockview, flexlayout-react, rc-dock, allotment (mouse-only), react-mosaic, `@dnd-kit/*`, react-dnd, and every toast library that injects its own stylesheet. |
| Headless UI primitives | ADOPT-with-constraints `@base-ui/react` 1.7.0 as the one widget family; ADOPT `tinykeys` 4.0.0 as the chord parser only; ADOPT `@floating-ui/react-dom` for our own non-widget overlays; OWN-BUILD the keybinding service and when-clause grammar, the command registry and palette, the fuzzy scorer (a port of VS Code's `fuzzyScore`, MIT), the live announcer, roving tabindex for ledger rows, and the modal `inert` guard | The only family complete for the console's widget list, including combobox and autocomplete, with zero CSS and subpath exports (89.6 kB gzip for the console set). Exact pin; subpath imports only; every popup portals into our overlay root; no body scroll lock; the shell applies `inert` to the app root while a modal is open until the upstream focus defect closes. Runner-up `react-aria-components` with a named flip trigger (a vendor screen-reader matrix becoming a sign-off requirement). AVOID Ariakit, Headless UI, cmdk, kbar, react-hotkeys-hook, focus-trap-react, react-focus-lock. |
| State, storage, forms, search, dates | ADOPT-with-constraints zustand 5 (one store per open session, partitioned entity maps, per-frame event coalescing, per-row selectors, no `persist` or `immer` on the event path); ADOPT-with-constraints `idb` 8.0.3 under an own per-session partition, LRU trim, and quota gauge; OWN-BUILD the JSON Schema field mapper and schema form on Zod `fromJSONSchema`; OWN-BUILD the subsequence scorer shared by the palette, settings search, sidebar filter, and find; ADOPT native `Intl` and `Temporal` | §Security Hardening Baseline's CSP has no `unsafe-eval`, so every schema library that compiles validators at runtime (Ajv, and with it rjsf, JSON Forms, and jsoneditor validation) is disqualified before size is weighed. A flat entity map costs 1.3 ms per event at 20,000 entities and a partitioned one 57 µs. Temporal is renderer and main only; contracts stay on ISO strings and epoch milliseconds. AVOID jotai, valtio, mobx, immer, idb-keyval, dexie, localforage, `@rjsf/*`, `@jsonforms/*`, ajv, CodeMirror, fuse.js, fzf, minisearch, date-fns, dayjs, both Temporal polyfills. |
| Motion, fonts, icons, meters, formatting | ADOPT platform motion (CSS transitions, `@starting-style`, View Transitions, the Web Animations API); OWN-BUILD a spring sampler emitting `linear()` easings; ADOPT-with-constraints `unplugin-icons` with `@iconify-json/tabler` plus our own signature-glyph collection compiled at build time; ADOPT IBM Plex Sans and IBM Plex Mono variable builds self-hosted from the foundry packages; OWN-BUILD the meters, sparklines, and arcs as SVG and CSS; ADOPT native `Intl` for numbers, currency, bytes, durations, and relative time | An animation library on the render path fights the virtualizer (layout measurement per render, own frame loops, per-child observers). Lucide is the default icon set of the most common component kit, so it reads as the generic dashboard look. The fontsource builds strip the `zero`, stylistic-set, and width features, so the faces come from the foundry packages. AVOID `motion` as a layer, `react-spring`, `@formkit/auto-animate`, Inter, Geist, commercial monospace faces, uplot, visx, recharts, nivo, `pretty-ms`, `filesize`, `bytes`. |

### Console Test Tiers

_Added 2026-09-01._ The console's tests are tiered by what each proves; every tier is a Vitest or Playwright project registered beside the `renderer` / `main` set the desktop package ships today and the `main-unit` / `e2e` projects Plan-023 registers (T-023p-1B-3, T-023r-8-1), each with a glob no other project reaches, and none is optional for a console PR.

| Tier | What it proves | Tooling |
| --- | --- | --- |
| unit | store transitions, projection arms, exhaustiveness, refusal grammar | Vitest with happy-dom |
| browser | geometry and pixel invariants: reading anchor, scroll chokepoint, reveal monotonicity, rect discipline | Vitest browser mode through `@vitest/browser-playwright` as its own project |
| end-to-end | flows declared as data over role and name locators, never test ids; specs named for the incident they reproduce | `@playwright/test` `_electron` against the `build:smoke` artifact; a separate check proves the release artifact's fuses are flipped |
| screenshot | the flagship frame at its frozen tick, and the gallery route of every primitive by state and theme | Playwright `toHaveScreenshot` on the Electron window; Vitest `toMatchScreenshot` per component |
| accessibility | zero violations on every route and dialog (WCAG 2.2 AA) | `@axe-core/playwright` (test-only MPL-2.0 dependency, [ADR-020 §Decision Log](../decisions/020-v1-deployment-model-and-oss-license.md#decision-log)) |
| endurance | flat heap over a thirty-minute multi-lane replay | heap snapshots captured by an own CDP helper, analyzed with memlab; results in a dated ledger that records refutations |
| architecture | every tripwire (no `scrollTop` write outside the chokepoint, no `scrollIntoView`, no runtime `process.env` gate, no `dangerouslySetInnerHTML` outside the math-owned node, no direct `window.sidekicks` outside the bridge provider, no second mount door for a pane kind, no import from a plan-owned subtree except the absorbed components, no banned string, no store reading another store's flag, every `define`-gated module unreachable from a release entry), each asserting it matched at least one site | lint tests |
| assets | generated tokens and schema artifacts byte-identical to their sources | CI byte diff |
| bundle | initial and lazy chunk sizes within `§Console Design (Meridian)`'s budgets | `size-limit`; `knip` for dead exports |

### Renderer Bundle

React + Vite per ADR-016; TypeScript strict. Vite produces ES module output; the main process loads the bundle via a custom protocol (not `file://`, because the `GrantFileProtocolExtraPrivileges` fuse is disabled) with strict CSP (no `eval`, no inline scripts, no `unsafe-eval`).

**Renderer scheme privileges (2026-09-01).** The custom scheme the bundle is served from must be registered through `protocol.registerSchemesAsPrivileged` as `standard: true` and `secure: true` **before** `app.ready`. On a non-standard scheme Chromium exposes neither IndexedDB nor `localStorage`, so the console's persisted layouts, drafts, and pins (`§Console Design (Meridian)` §Persistence on the renderer scheme) would have no home; Plan-023 carries the registration as I-023-11, shipped by its Tier-1 supplement Phase 1B, and the console runs on an in-memory persistence adapter until that phase merges.

**Renderer clipboard deprecation (Electron 40+):** Direct clipboard-API usage in renderer processes was deprecated in Electron 40. Clipboard access must be exposed via the preload bridge's `native.copyToClipboard` surface and implemented in the main process. The renderer must not call `navigator.clipboard.*` directly; CI lint must catch such imports.

## Pitfalls To Avoid

- **Giving the renderer any form of Node or process access.** `nodeIntegration: true` or `sandbox: false` in any window must be treated as a build-time error.
- **Leaking auth material across the bridge.** Audit the preload surface — any function returning a PASETO token (including the relay `connectionToken`), DPoP proof, WebAuthn PRF output, or daemon session token to the renderer is a security regression. Relay negotiation is main-process-owned; its `connectionToken` is consumed in the main process to open the relay WSS and MUST NOT appear in any bridge response.
- **Skipping asar integrity verification in release builds.** `EnableEmbeddedAsarIntegrityValidation` must be enabled for every release; disabling it (even temporarily for debugging) in a signed release binary defeats the tamper-detection posture.
- **Coupling renderer lifecycle to daemon lifecycle.** Daemon disconnect must degrade the renderer to read-only mode, not crash it. Daemon crash with automatic restart must not lose renderer state.
- **Letting the renderer hold session-scoped state that should be re-derived from the daemon on reconnect.** State kept for fast UX (e.g., scroll position) is fine; state kept as truth (e.g., pending-approval list) creates divergence when the daemon reconnects.
- **Registering the `sidekicks://` protocol handler without conflict resolution.** On first run, if a prior installation already claims the handler, the new installation must either displace it explicitly or surface the conflict.
- **Treating the auto-update signature key as if it were the code-signing certificate.** They are separate keys with separate rotation schedules; conflating them risks a rotation mishap invalidating installed binaries.
- **Shipping renderer code that imports Node built-ins.** Vite's build must fail fast on accidental Node imports in the renderer bundle.
- **Polling the daemon on an interval from the renderer.** Reads happen on subscribe, on window focus, on reconnect, and on the terminal events the owning spec names; a renderer timer that re-reads on a cadence is the idle-CPU budget's first casualty and a second source of freshness the subscription already provides (`§Console Design (Meridian)`).
- **Projecting eligibility in the renderer.** A control the daemon may refuse is offered and its typed refusal is rendered; a renderer that pre-denies re-derives a rule it does not own, the `I-004-24` fail-closed-projection discipline every console surface generalizes.
- **Leaving fixture scenarios in a release bundle.** The fixture bridge, every scenario, and the scenario switcher sit behind the same compile-time `define` gate as the smoke probes in the next bullet; a runtime `process.env` gate around any of them is a tripwire failure, not a style choice.
- **Embedding test-only code paths in production binaries.** Test-machinery (smoke probes, debug-only branches, internal instrumentation hooks) must be eliminated from release bundles via a compile-time-static gate — e.g., a Vite `define`-substituted identifier (`__SIDEKICKS_SMOKE_BUILD__`-style) so Rollup's tree-shaker collapses `if (false && expr)` branches and physically strips the probe body from the shipped artifact. A runtime-only env-var check (`if (process.env.SOME_FLAG === '1')`) leaves the test code present in the bundle and weakens the §Trust Stance posture + earlier bullets in this section (every additional code path in a release binary is reachable surface). The runtime check is fine as defense-in-depth on the inner side of the compile-time gate, but never as the sole gate.

## Acceptance Criteria

- [ ] The shell creates every `BrowserWindow` with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, and a preload script that uses only `contextBridge.exposeInMainWorld` — verified by contract test
- [ ] No auth material (daemon session token, PASETO tokens, DPoP key, WebAuthn PRF output) appears on the `window.sidekicks` surface — verified by a negative contract test against the bridge's exposed type
- [ ] Every Electron Fuse declared in §Security Hardening Baseline is set to the declared value in every released binary — verified by a build-time assertion
- [ ] WebAuthn PRF-based sign-in flow succeeds on Windows, macOS, and Linux against a platform authenticator — verified by Plan-023 integration tests per ADR-016 Success Criteria
- [ ] The shell supervises the daemon via `utilityProcess.fork`, restarts on crash with the declared backoff, and surfaces persistent-error state after five failed attempts — verified by integration test
- [ ] Auto-update download + signature verification + staged-apply + post-apply daemon handshake is exercised end-to-end on every release platform in CI — verified by Plan-023 release-gate test
- [ ] Code-signed release artifacts pass Gatekeeper (macOS), SmartScreen (Windows 10/11), and the configured Linux package-manager signature check — verified by Plan-023 release smoke test
- [ ] Every Signature Feature view (timeline, approvals, invites, runs, multi-agent channels) composes the owning-plan contract without duplicating daemon logic — verified by renderer unit tests against mocked bridge methods
- [ ] `sidekicks://invite/<token>` deep-link handling accepts an invite without the raw token crossing the bridge — verified by integration test asserting the bridge-surface transcript
- [ ] Shell bundle size (post-asar, post-compression) is under the ADR-016 Success Criteria target of 150 MB — verified by CI artifact size check
- [ ] The preload bridge surface has no `any`-typed escape hatch in its public type — verified by TypeScript strict-mode build
- [ ] Renderer attempts to access `require`, `process`, or `global` return `undefined` — verified by runtime assertion in a sandbox test
- [ ] The main-process `BrowserWindow` handle remains V8-reachable across the `app.whenReady().then(...)` callback unwind in a release-mode build, such that `window-all-closed` does not fire until the user closes the window — verified by a `--js-flags=--expose-gc` lifecycle probe asserting (a) `v8.queryObjects(BrowserWindow)` count `≥ 1` across repeated GC pressure cycles AND (b) `window-all-closed` does not fire during the probe iteration loop. Per `ADR-024 §Antithesis — The Strongest Case Against`, the load-bearing reachability mechanism is Electron's native-side `BaseWindow::self_ref_` (`v8::Global<v8::Value>` field declared at `electron_api_base_window.h:271`, set in `InitWith` at `electron_api_base_window.cc:155`, reset only at native-object destruction at `electron_api_base_window.cc:130`); user-side module-scope retention is defensive consistency with the canonical Electron community pattern, not the primary GC-anchor.
- [ ] The edit-and-resend entry point sits in the participant `user.message` row footer and dispatches the existing `rollback` intervention rather than adding a new run control; its hidden / disabled / disabled-with-stated-reason states, its dim-not-remove treatment of the rows a rewind would cut, and its "queued, sends on the next Resume" confirm copy are rendered from the owning plan's projection and never re-derived in the renderer — verified by renderer unit tests against a mocked bridge
- [ ] The composer's command-and-skill autocomplete offers only entries enumerated under the **target agent's** own `(driverName, providerAccountId)` binding, and re-addressing the composer to an agent of a different binding re-reads rather than filters — a Claude-enumerated command is never listed for or dispatched through a Codex agent.
- [ ] Each capability-gated composer affordance (compaction, output speed, command autocomplete) is **absent** rather than present-and-disabled where its driver flag is `false`, and the compaction control's completed state renders only on the daemon's compaction row rather than on the call returning.
- [ ] The MCP Servers page renders every value wire-verbatim from the `mcp.*` reads and the governance subscription, recomputes no trust state and no effective idempotency class, renders no **withheld** configuration value — no environment-variable value, header value, URL query value, or token — while still rendering the daemon's redacted config read-back so the declaration can be inspected and edited, holds an OAuth launch URL as transient state that is persisted nowhere and dropped at settlement, and issues exactly one wire mutation per explicit operator action.
- [ ] Every console surface renders in the Meridian design language of `§Console Design (Meridian)`: participant identity is carried by the per-participant hue and attention by amber and red alone, every wire figure renders in the mono face verbatim, and the two-hue rule and the contrast floors are enforced at the token level — verified by the gallery-route screenshot and accessibility sweeps
- [ ] The console builds and its renderer tests run against the fixture bridge, shape-identical to `SidekicksBridge` namespace for namespace, and a release bundle contains no fixture scenario and no scenario switcher — verified by the release-bundle probe-elimination check
- [ ] The budgets in `§Console Design (Meridian)` are measured on every console PR and a regression fails CI: renderer initial bundle ≤ 450 kB gzip, idle CPU ≤ 0.5 % of one core with a session open, renderer heap ≤ 120 MB with one session open at rest, and p95 frame time ≤ 16.7 ms with four lanes streaming — verified by the bundle gate and the endurance ledger
- [ ] Notification mute is offered globally only and no per-session mute control renders; the Invites View's received-invite hide issues no wire call — verified by renderer unit tests against a mocked bridge
- [ ] Every `BrowserWindow` the console opens — the two auxiliary windows included — satisfies the first criterion in this list, and no auxiliary window shares an in-memory store or any auth material with the main window — verified by the multi-window end-to-end tier

## ADR Triggers

- If the shell needs a renderer-trusted trust stance (for any reason — e.g., DOM-side cryptography that cannot round-trip through the main process), an ADR must supersede ADR-016's stance and reconcile with `container-architecture.md` and `security-architecture.md` in one coherent motion.
- If `utilityProcess` proves inadequate for daemon supervision and the project needs a separate external daemon, update or replace ADR-016 §Daemon Supervision guidance.
- If a subsequent platform is added (e.g., web-hosted renderer), the renderer-side assumptions here must be re-derived; this spec is desktop-only.
- If the `browser` pane kind (`§Console Design (Meridian)`) is wired live, a Type-2 ADR for the embedded browser subsystem lands first — a native `WebContentsView` hosted beside the renderer, answering agent-driven tool calls, is a one-way architectural door — together with the `browser.*` bridge-namespace amendment to §Preload Bridge Contract that names this spec as its owner.
- If a decision is made to move off `electron-updater` (for example to `update.electronjs.org` hosted service), document the feed and signing-key implications in an ADR before the migration.

## Open Questions

- **Crash-reporter sink (Sentry Electron SDK vs self-hosted symbolication):** deferred to a follow-up BL owned by Plan-023; decision depends on operational maturity of the self-hosted symbolication pipeline and on PII-handling review. The requirements both options must satisfy are declared in §Implementation Notes §Crash Reporting.
- **Azure Artifact Signing regional eligibility for this project's issuing organization:** Public Trust is USA/Canada/EU/UK organizations + US/Canada individuals only. Organizational account review pending before lock-in; fallback is a traditional EV cert from DigiCert / Sectigo / SSL.com (now ≤14-month / ≤460-day validity per [CSCBR v3.10.0 §6.3.2](https://cabforum.org/uploads/CA-Browser-Forum-CSCBR-3.10.0.pdf), not 3-year), OR SignPath Foundation $0 OSS sponsorship with publisher attribution = "SignPath Foundation" (UX trade-off).
- **WebAuthn native-module lock-in for Windows + Linux:** `@electron-webauthn/native` is published as cross-platform but coverage beyond macOS could not be authoritatively confirmed in the 2026-04 research pass. Plan-023 must prototype Windows Hello and Linux platform / roaming authenticator flows against the candidate module before locking it in; if cross-platform fails, per-platform strategy (Vault12 module on macOS, Device Authorization Grant fallback elsewhere) is the accepted degradation.
- **Windows 10 V1 support horizon:** Windows 10 reached EOL on 2025-10-14. V1 currently supports Windows 10 + 11 (x64). V1.1 may tighten to Windows 11 only; this is a scope-policy decision pending, not a technical blocker.
- **MSIX (Windows Store) distribution:** Not in V1 scope (V1 ships NSIS / MSI direct-download). Electron 41 added MSIX auto-updating; re-evaluate for V1.1.
- **Reproducible builds:** Not claimed by V1 (neither electron-builder nor Electron Forge guarantees them out of the box). Revisit for V1.1 if supply-chain verification becomes a requirement.
- **Linux package-manager presence:** V1 ships `.AppImage`, `.deb`, and `.rpm`; whether to also ship a Snap / Flatpak manifest is a follow-up gated on user-demand signal.
- **WebAuthn PRF fallback UX:** The Device Authorization Grant fallback is documented, but the UX gate (how the user discovers their authenticator is insufficient, how they are guided to the fallback) needs surfacing in Spec-026 (BL-081) first-run onboarding.

## References

### Research Conducted

A dedicated current-state research pass (Electron version / cadence, security hardening, IPC / preload bridge, code signing, auto-updater, native keystore, crash reporting, build tooling, utility-process patterns, WebAuthn, and 2026 greenfield red flags) was run on 2026-04-17 and integrated inline in §Required Behavior and §Implementation Notes. Primary sources are cited with each integration. The table below indexes the sources for reviewer traceability.

| Source | Type | Key Finding | URL |
| --- | --- | --- | --- |
| Electron release timeline | Documentation | 3-major support window, 8-week cadence, no LTS lane | <https://www.electronjs.org/docs/latest/tutorial/electron-timelines> |
| Electron release schedule | Documentation | v41 EOL 2026-08-25; forced upgrade cadence confirmation | <https://releases.electronjs.org/schedule> |
| Electron 41.0 release notes | Release notes | Chromium 146, Node 24.14, ASAR Integrity Digest, MSIX auto-update | <https://www.electronjs.org/blog/electron-41-0> |
| Electron 40.0 release notes | Release notes | `utilityProcess` `"memory-eviction"` exit reason; renderer clipboard deprecation; macOS dSYM format change | <https://www.electronjs.org/blog/electron-40-0> |
| Electron 39.0 release notes | Release notes | ASAR Integrity graduated to stable; `@electron/packager` v19 enables it by default | <https://www.electronjs.org/blog/electron-39-0> |
| Electron Security Checklist | Documentation | 20-item hardening checklist — the basis for §Security Hardening Baseline | <https://www.electronjs.org/docs/latest/tutorial/security> |
| Electron Fuses documentation | Documentation | Fuse defaults and recommended production posture | <https://www.electronjs.org/docs/latest/tutorial/fuses> |
| Electron IPC tutorial | Documentation | `contextBridge` + `invoke` / `handle` patterns | <https://www.electronjs.org/docs/latest/tutorial/ipc> |
| Electron `utilityProcess` API | Documentation | Chromium-Services-backed process model; `MessagePortMain`; post-`app.ready` requirement | <https://www.electronjs.org/docs/latest/api/utility-process> |
| Electron Message Ports tutorial | Documentation | `ipcRenderer.postMessage` required for MessagePort transfer | <https://www.electronjs.org/docs/latest/tutorial/message-ports> |
| Electron `safeStorage` API | Documentation | Linux plaintext-fallback when no keystore; `getSelectedStorageBackend` check | <https://www.electronjs.org/docs/latest/api/safe-storage> |
| Electron `autoUpdater` API | Documentation | Built-in updater: Squirrel.Mac / Squirrel.Windows or MSIX; no Linux support | <https://www.electronjs.org/docs/latest/api/auto-updater> |
| Electron `crashReporter` API | Documentation | Crashpad-based; multipart/form-data upload; 39/127-byte metadata limits | <https://www.electronjs.org/docs/latest/api/crash-reporter> |
| Electron Forge overview | Documentation | Officially-recommended packaging; v7.11.1 stable, v8.0.0 alpha (ESM) | <https://www.electronjs.org/docs/latest/tutorial/forge-overview> |
| Electron GitHub Security Advisories | Primary source | Q1 2026 CVE batch (2026-04-02): 34769/34770/34771/34772/34774/34764 | <https://github.com/electron/electron/security/advisories> |
| electron-builder releases | Release notes | v26.9.0 (2026-04-14); v26.8.2 (2026-03-04) tar security patches | <https://github.com/electron-userland/electron-builder/releases> |
| electron.build auto-update docs | Documentation | Code-signature validation on macOS + Windows; staged rollouts; NSIS-only block-map delta | <https://www.electron.build/auto-update> |
| Electron Forge GitHub | Source | v7.11.1 stable (2026-01-12); v8.0.0-alpha.7 (2026-04-10) | <https://github.com/electron/forge> |
| update.electronjs.org | Source | Restrictions: public GitHub repos only; macOS + Windows only; no Linux | <https://github.com/electron/update.electronjs.org> |
| node-keytar archive | Primary source | Archived 2022-12-15; last release v7.9.0 (2022-02-17) | <https://github.com/atom/node-keytar> |
| `@napi-rs/keyring` npm | Package | v1.2.0 (2025-09-02); keytar-compatible replacement; no libsecret required on Linux | <https://www.npmjs.com/package/@napi-rs/keyring> |
| `@napi-rs/keyring` GitHub | Source | Rust napi-rs binding to keyring-rs crate | <https://github.com/Brooooooklyn/keyring-node> |
| MSAL JS issue #7170 | Primary source | Microsoft's migration off keytar (corroborating) | <https://github.com/AzureAD/microsoft-authentication-library-for-js/issues/7170> |
| CA/Browser Forum CSC-31 | Primary source | Adopted 2025-11-17, effective 2026-03-01: 460-day max cert validity | <https://cabforum.org/working-groups/code-signing/requirements/> |
| Microsoft — Artifact Signing GA | Primary source | Renamed from Trusted Signing; GA 2026-01-12; Basic SKU pricing | <https://techcommunity.microsoft.com/blog/microsoft-security-blog/simplifying-code-signing-for-windows-apps-artifact-signing-ga/4482789> |
| Azure Artifact Signing FAQ | Documentation | Regional eligibility (USA/Canada/EU/UK orgs; US/Canada individuals); no EV cert issuance | <https://learn.microsoft.com/en-us/azure/artifact-signing/faq> |
| Apple Developer ID | Documentation | Developer ID cert free under $99/yr program; notarization required | <https://developer.apple.com/developer-id/> |
| Apple Developer forum — notarization delays | Primary source | January 2026: 24–120+ hour queue delays reported | <https://developer.apple.com/forums/thread/813441> |
| Microsoft — Windows 10 lifecycle | Primary source | Windows 10 EOL 2025-10-14 | <https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro> |
| Sentry Electron SDK documentation | Documentation | Per-process init (`@sentry/electron/main` / `/renderer` / `/utility`) | <https://docs.sentry.io/platforms/javascript/guides/electron/> |
| `electron-webauthn-mac` (Vault12) | Source | Jan 2026 open-source release; bridges Apple `AuthenticationServices` for passkeys | <https://github.com/vault12/electron-webauthn-mac> |
| `@electron-webauthn/native` | Package | Published as cross-platform; scope beyond macOS not authoritatively confirmed in this pass | <https://www.npmjs.com/package/@electron-webauthn/native> |
| electron/electron #15404 | Primary source | Long-standing open issue on native WebAuthn support | <https://github.com/electron/electron/issues/15404> |
| electron/electron #24573 | Primary source | Long-standing open issue on WebAuthn bindings | <https://github.com/electron/electron/issues/24573> |
| GitLab Advisory DB — CVE-2026-34769 | Primary source | Example high-severity entry from Q1 2026 batch | <https://advisories.gitlab.com/pkg/npm/electron/CVE-2026-34769/> |
| RFC 9449 — OAuth 2.0 DPoP | Primary source | `Authorization: DPoP` presentation scheme (§7.1) + `ath` proof claim (§4.3) for DPoP-bound tokens (added 2026-08-02, PR #279 — post-dates the 2026-04-17 pass) | <https://datatracker.ietf.org/doc/html/rfc9449> |

### Console Design Research Pass (2026-09-01)

The console design track ran 2026-08-29 through 2026-09-01: a whole-corpus survey of every renderer-facing surface the specs name, a reference-mechanics study that adopts mechanics and never skin, and a library-leverage pass under the rule stated in §Console Libraries. Its decisions are integrated in `§Console Design (Meridian)`, §Console Libraries, §Console Test Tiers, and §Electron Version And Support Window; the rows below index the sources per axis for reviewer traceability. Type is one of: registry, upstream source, upstream docs, issue, changelog, measurement (local, in the repository's own Electron binary), license text, spec.

**D.1 Timeline virtualization**

| Source | Type | Key Finding | URL |
| --- | --- | --- | --- |
| Chromium `LayoutUnit` (Blink; Electron 41.6.1 ships Chromium 146.0.7680.65 per the v41.0.0 release notes) | Source file | `kIntMax = kRawValueMax / kFixedPointDenominator` = 2147483647 / 64 = 33,554,431 px maximum element height, so 100k rows at 300 px (30 M px) sit at 89% of the ceiling and the window cap is mandatory. | https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/geometry/layout_unit.h |
| CSS Scroll Anchoring Module | Spec | Anchoring is suppressed by any change to `top/left/right/bottom`, margin, padding, width/height, `position`, or `transform` on the anchor-to-scroller path, which every virtualizer's row positioning triggers, so sub-row anchoring must be own-built. | https://drafts.csswg.org/css-scroll-anchoring/ |
| `@tanstack/react-virtual` npm manifest | Registry | 3.14.10 published 2026-08-18 (core 3.17.8), MIT, peer React ^16.8 through ^19, ESM+CJS with types, 23,240,523 weekly downloads. | https://registry.npmjs.org/@tanstack%2Freact-virtual/latest |
| TanStack Virtualizer API docs | Docs | `getScrollElement`, `scrollToFn`, `observeElementRect`, and `observeElementOffset` are all overridable options and `shouldAdjustScrollPositionOnItemSizeChange` gates the only other scroll write, so our chokepoint can be the sole `scrollTop` writer. | https://tanstack.com/virtual/latest/docs/api/virtualizer |
| `@tanstack/virtual-core@3.16.0` release | Changelog | `anchorTo: 'end'` landed 2026-05-25 and "keeps an end-pinned viewport pinned when the last item grows during streaming output" while keeping the visible item stable on prepend. | https://github.com/TanStack/virtual/releases/tag/%40tanstack%2Fvirtual-core%403.16.0 |
| `@tanstack/virtual-core@3.17.6` release | Changelog | Re-measurements now compensate only items entirely above the fold (`itemStart + itemSize <= scrollOffset`), fixing #1218 where a fold-spanning streaming message dragged `scrollTop` token by token, so anything older is broken for streaming. | https://github.com/TanStack/virtual/releases/tag/%40tanstack%2Fvirtual-core%403.17.6 |
| TanStack React adapter docs | Docs | React 19 can log "flushSync was called from inside a lifecycle method" unless `useFlushSync: false`, and `directDomUpdates` (3.14.0) skips React on scroll ticks, which PR #1141 measured at 407 to 215 renders on a 200x100 px scripted scroll. | https://tanstack.com/virtual/latest/docs/framework/react/react-virtual |
| TanStack issue #1221 | Issue | Open: no public API to cancel or retarget the rAF reconcile loop armed by `scrollTo*`/`scrollBy`, so our controller must not depend on smooth `scrollToIndex`. | https://github.com/TanStack/virtual/issues/1221 |
| `virtual-core/src/index.ts` and `react-virtual/src/index.tsx` | Source file | One lazily created `ResizeObserver` per virtualizer with `elementsCache` entries deleted when a node is no longer connected; the core is 2,111 lines and the React adapter 279 lines (`useFlushSync` defaults to `true`). | https://github.com/TanStack/virtual/blob/main/packages/virtual-core/src/index.ts |
| TanStack first-party benchmark README | Benchmark | Medians of 5 Chromium runs: mount-fixed-100k tanstack 6.1 ms vs virtua 3.1 ms, memory 14.2 MB vs 10.5 MB, virtuoso 188 ms dynamic settle and 154 ms jump-to-end, all four at 60 fps on a scroll the README calls "too gentle to expose perf differences". | https://github.com/TanStack/virtual/blob/main/benchmarks/README.md |
| React Aria comparison section of the same README | Benchmark | Full `react-aria-components` Virtualizer stack mounts in 175.2 ms at 100k (vs 5.8 ms headless TanStack), uses 99.7 MB, and returns a `-1` landing error because it exposes no `scrollToIndex`. | https://github.com/TanStack/virtual/blob/main/benchmarks/README.md |
| esbuild 0.27.3 bundle measurement (min, ESM, `chrome146`, React externalized, gzip -9) | Measured (ours) | `@tanstack/react-virtual` 7.6 kB gz, `virtua` `VList` 4.2 kB, `react-virtuoso` `Virtuoso` 20.0 kB, `react-window` `List`+`useDynamicRowHeight` 3.7 kB, `react-virtualized` `List`+`CellMeasurer`+`AutoSizer` 28.4 kB, `use-stick-to-bottom` 2.7 kB. | https://esbuild.github.io/api/#bundle |
| `virtua` `src/core/driver.ts` | Source file | The driver itself calls `viewport.scrollTo({behavior:'instant'})` and `scrollBy` for jump compensation with no opt-out, so it would fight an external scroll chokepoint. | https://github.com/inokawa/virtua/blob/main/src/core/driver.ts |
| virtua issue #901 | Issue | Open: `flushSync` inside the `ResizeObserver` path triggers a Blink `FATAL ... StateAllowsTreeMutations()` crash when a contenteditable caret paints in the same frame. | https://github.com/inokawa/virtua/issues/901 |
| virtua issue #301 | Issue | Open since 2023-12-28: scroll position does not stay at the bottom when the viewport height changes, with the maintainer's 2024-01 reply "It's planned but not right away". | https://github.com/inokawa/virtua/issues/301 |
| `react-virtuoso` `hooks/useChangedChildSizes.ts` | Source file | A single `ResizeObserver` watches the items container and every callback walks `el.children` reading `offsetHeight` of each mounted row, so N streaming lanes force O(mounted rows) layout reads per resize. | https://github.com/petyosi/react-virtuoso/blob/main/packages/react-virtuoso/src/hooks/useChangedChildSizes.ts |
| React Virtuoso troubleshooting docs | Docs | "If you have zero-height items, you need to filter those out before passing them to the component ... There's no way to fix this", and `contentRect` measurement ignores margins. | https://virtuoso.dev/react-virtuoso/troubleshooting |
| react-virtuoso issue #1354 | Issue | Open since 2026-02-09: using `alignToBottom` with `firstItemIndex` prepends makes the list flicker to the top of the area. | https://github.com/petyosi/react-virtuoso/issues/1354 |
| `@virtuoso.dev/message-list` npm manifest | Registry | 1.17.2 (2026-08-28) declares `"license": "Commercial"` and requires a `VirtuosoMessageListLicense` key. | https://registry.npmjs.org/@virtuoso.dev%2Fmessage-list/latest |
| `react-window` `lib/components/list/List.tsx` | Source file | The `List` renders its own `overflowY: "auto"` scroll element and hard-codes `role="list"` / `role="listitem"` with `aria-posinset`/`aria-setsize`, so it cannot attach to an external scroller. | https://github.com/bvaughn/react-window/blob/main/lib/components/list/List.tsx |
| react-window issue #883 | Issue | Open: maintainer states "I don't think there's a good way for me to improve this use case" for `scrollToRow` landing on dynamic-height rows because the target offset is only an estimate. | https://github.com/bvaughn/react-window/issues/883 |
| `react-virtualized` README and npm manifest | Docs | README steers users to `react-window` "as a possible lighter-weight alternative"; latest 9.22.6 was published 2025-01-20 with zero releases in the last 12 months and no bundled types. | https://github.com/bvaughn/react-virtualized/blob/master/README.md |
| MDN `content-visibility` | Docs | With `content-visibility: auto` skipped content remains in the DOM and accessibility tree and is findable and focusable, so all 100k rows stay as live DOM nodes. | https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility |
| CSSWG issue #9833 | Issue | Open: scroll-into-view targets drift as `content-visibility: auto` children swap `contain-intrinsic-size` for real size mid-scroll, so the CSS-only approach would undermine an anchor controller. | https://github.com/w3c/csswg-drafts/issues/9833 |
| `use-stick-to-bottom` `src/useStickToBottom.ts` | Source file | The 665-line hook sets `scrollRef.current.scrollTop` itself and animates with a spring (`damping 0.7`, `stiffness 0.05`, `mass 1.25`) over non-virtualized content, so it competes with both the chokepoint and any virtualizer. | https://github.com/samdenty/use-stick-to-bottom/blob/main/src/useStickToBottom.ts |

**D.2 Streaming markdown, highlighting, math, diagrams**

| Source | Type | Key Finding | URL |
| --- | --- | --- | --- |
| Whole-message re-parse benchmark (marked, markdown-it, micromark, mdast) | Measured (ours) | Full re-parse per call at 64 KB is 4.49 ms (marked Lexer), 7.47 ms (markdown-it), 76.8 ms (micromark), 94.3 ms (mdast), linear in length so O(n²) over a stream, while a 256 B–2 KB tail slice costs 0.30–1.31 ms (mdast) or 0.03–0.13 ms (marked). | https://github.com/syntax-tree/mdast-util-from-markdown |
| esbuild min+gzip sizes of parser/renderer surfaces | Measured (ours) | mdast+gfm 78.2/22.2 KB versus unified remark-parse+gfm+rehype+sanitize+to-jsx 154.7/46.9 KB, react-markdown+gfm+math+katex 429.2/126.5 KB, markdown-it 110.7/46.8 KB, streamdown core (no plugins) 497.6/148.4 KB across 4 chunks. | https://registry.npmjs.org/react-markdown/latest |
| micromark security advisories | Docs | "There aren't any published security advisories" for micromark. | https://github.com/micromark/micromark/security/advisories |
| mdast-util-gfm node output | Measured (ours) | `mdast-util-gfm` emits native `footnoteReference` and `footnoteDefinition` nodes and raw HTML arrives as droppable `html` nodes at block and inline level (`<div onclick=…>` and `<b>` both). | https://github.com/syntax-tree/mdast-util-gfm |
| marked Lexer behavior (18.0.11) | Measured (ours) | `Lexer.lex` called twice concatenates two independent parses (not incremental), `Some text\n-` lexes as an h2 setext heading, and a table header only becomes a `table` when the delimiter row arrives; separately GHSA-6v9c-7cg6-27q7 (high, tokenizer OOM in 18.0.0–18.0.1) was patched in 18.0.2. | https://marked.js.org/using_pro |
| markdown-it GHSA-253c-mchw-3w2r | Issue | `linkify: true` has two quadratic paths that block the event loop for tens of seconds (medium, published 2026-08-27, patched in 15.0.1), following the 2026-05-23 smartquotes quadratic-DoS advisory. | https://github.com/markdown-it/markdown-it/security/advisories/GHSA-253c-mchw-3w2r |
| markdown-to-jsx README (9.10.2) | Docs | `disableParsingRawHTML` defaults to `false` ("Arbitrary HTML is supported and parsed into the appropriate JSX representation") and `optimizeForStreaming` holds incomplete structures back by "returning `null` on React" rather than settling them. | https://github.com/quantizor/markdown-to-jsx#readme |
| Streamdown `parse-blocks.tsx` and dist pipeline (2.6.0) | Source file | `parseMarkdownIntoBlocks` runs `Lexer.lex(markdown, { gfm: true })` on the full string every call, returns the whole message as one block when footnotes are present, and each block renders through `remark-rehype({ allowDangerousHtml: true }) → rehype-raw → rehype-sanitize → rehype-harden` with 90 Tailwind `className` sites and a `tailwind-merge` runtime dependency. | https://github.com/vercel/streamdown/blob/main/packages/streamdown/lib/parse-blocks.tsx |
| Streamdown issue #543 "Make tailwind optional" | Issue | Open since 2026-06-25, alongside #473 (fenced code does not render incrementally, open 2026-03-21) and #195 (large code blocks freeze the tab under synchronous shiki). | https://github.com/vercel/streamdown/issues/543 |
| `@streamdown/code` dist (1.1.1) | Source file | Imports `bundledLanguages` from full `shiki` and calls `createHighlighter({ themes, langs: [lang], engine })` per language key, measuring 9.4 MB / 1.79 MB gz across 348 chunks. | https://registry.npmjs.org/@streamdown/code/latest |
| remend behavior (1.3.1) | Measured (ours) | Closes unterminated `**`, `*`, `` ` ``, `~~`, `$$`, leaves open fences and partial tables untouched, rewrites an unfinished link target to the sentinel `streamdown:incomplete-link`, and bundles to 12.8/4.3 KB with zero deps under Apache-2.0. | https://registry.npmjs.org/remend/latest |
| vercel-labs/markdown-sanitizers README | Docs | `rehype-harden`/`harden-react-markdown` only apply on a hast pipeline and the README warns "If you use `rehype-raw` or any plugin that allows embedded raw HTML, you must pair it with a sanitizer such as `rehype-sanitize`." | https://github.com/vercel-labs/markdown-sanitizers |
| `@incremark/core` registry | Registry | 1.0.2 (2026-03-13), first published 2025-12-14, ~3.3k weekly downloads, depends on `lodash-es` plus both `marked` and the micromark/mdast stack, and `@incremark/react` measures 13.2 MB / 2.86 MB gz across 454 chunks. | https://registry.npmjs.org/@incremark/core |
| `streaming-markdown` and `@llm-ui/react` registries | Registry | `streaming-markdown` 0.2.15 (2025-05-04, no release in 12 months, self-described WIP, DOM-writing, no footnotes) and `@llm-ui/react` 0.13.3 (2024-06-01, peer `react ^18` only). | https://registry.npmjs.org/streaming-markdown |
| Shiki best-performance guide | Docs | "Avoid importing `shiki`, `shiki/bundle/full`, `shiki/bundle/web` directly", create the highlighter once (singleton), and call `dispose()` because "It can't be GC-ed automatically". | https://shiki.style/guide/best-performance |
| Shiki JavaScript-engine compatibility report | Docs | At 4.3.1 (2026-07-31) the JS engine supports 237 languages with 0 mismatched and 1 unsupported (`ahk2`); it wants ES2024 (Electron 44.x ships Chromium 152), and the JS Raw/precompiled engine has open mis-highlighting bug #918. | https://shiki.style/references/engine-js-compat |
| Shiki heap, speed, and token-retention measurements (4.4.3) | Measured (ours) | JS engine highlighter costs +2.9 MB heap (5 grammars) to +14.9 MB (40) with no WASM, Oniguruma adds +16.8 MB external growing to +28.6 MB after 50 highlights; TypeScript costs 12.7 ms at 4 KB and 183 ms at 64 KB (8.1 ms per 2.7 KB); retained tokens are 60.7 KB per 2.9 KB block (21.5× source). | https://registry.npmjs.org/shiki/latest |
| `@shikijs/stream` docs and dist (4.4.3) | Docs | `ShikiStreamTokenizer` emits stable line tokens with carried grammar state plus optional `recall` tokens that "discard the last N tokens that changed", peers on `react ^19`, and bundles to 1.5/0.6 KB (React entry 8.2/3.1 KB) with a hard-coded `<pre class="shiki shiki-stream">` renderer. | https://shiki.style/packages/stream |
| react-shiki README and measured core entry (0.11.1) | Docs | Re-highlights the whole growing block per throttled tick and its `/core` entry re-exports both engines, measuring 799.5/289.6 KB gz across 7 chunks. | https://github.com/AVGVSTVS96/react-shiki |
| highlight.js measurements (11.12.0) | Measured (ours) | Core + 5 languages 41.9/13.7 KB, `lib/common` 160.3/53.2 KB and 1.6 MB heap, 1.15 ms per 2.7 KB TypeScript block, HTML-string output, no incremental mode, BSD-3-Clause. | https://registry.npmjs.org/highlight.js/latest |
| prism-react-renderer and prismjs registries | Registry | prism-react-renderer 2.4.1 (2024-12-11, last commit 2025-01-02, peer `react >=16`) and prismjs 1.30.0 (2025-03-10, no bundled types, 486 open issues) have shipped nothing in 12 months. | https://registry.npmjs.org/prism-react-renderer/latest |
| sugar-high registry (2.2.0) | Registry | Declares MIT only in the `license` field (`files: ["lib"]`, no LICENSE file in the tarball, GitHub reports no license), emits an HTML string, and measures 25.1/9.2 KB at 2.1 ms per 2.7 KB. | https://registry.npmjs.org/sugar-high/latest |
| starry-night readme and measured import (3.11.0) | Docs | The readme says it "might be too heavy particularly in browsers"; importing with `common` costs 44.6 MB heap plus 17.9 MB WASM and bundles to 1,305/262 KB gz. | https://github.com/wooorm/starry-night |
| KaTeX options doc and measured assets (0.18.5) | Docs | `trust` defaults to `false`, `maxExpand` to 1000, `maxSize` to `Infinity`, `output` to `htmlAndMathml` with a `mathml`-only option; JS measures 261/75.2 KB, CSS 28 KB, and the 20 woff2 fonts 296 KB. | https://katex.org/docs/options |
| Mermaid security advisories and measured bundle (11.17.2) | Issue | Five advisories published 2026-08-04 (prototype pollution ×2, radar DoS, XY-chart infinite loop, CSS injection); the package measures 3.34 MB / 959 KB gz across 105 chunks and depends on `dompurify` (`MPL-2.0 OR Apache-2.0`), `katex ^0.16`, and `marked ^16`, so DOMPurify arrives only transitively. | https://github.com/mermaid-js/mermaid/security/advisories |

**D.3 Diff viewer**

| Source | Type | Key Finding | URL |
| --- | --- | --- | --- |
| `@pierre/diffs` | Registry | 1.3.6 published 2026-08-24, Apache-2.0, 99 releases since 1.0.0-beta.1 (2025-12-10), peer `react ^18.3.1 \|\| ^19.0.0`, ESM-only. | https://registry.npmjs.org/@pierre/diffs |
| `@pierre/diffs` docs (React, Virtualization, Styling) | Docs | Higher-order components render into Shadow DOM + CSS grid; virtualization exists only inside `Virtualizer`/`CodeView`; `unsafeCSS` carries no backwards-compatibility guarantee "even in patch versions". | https://diffs.com/docs |
| `@pierre/diffs` docs (Worker Pool) | Docs | `poolSize` defaults to 8 — "More workers = more parallelism but also more memory. Too many can actually slow things down." | https://diffs.com/docs |
| `@pierre/diffs` bundle | Measured (ours) | `PatchDiff`+`FileDiff`+`Virtualizer`+`WorkerPoolContextProvider` eager 510 KB min / 144 KB gz; per-worker bundle 608 KB / 225 KB gz; `parsePatchFiles` 9.7 ms on a 748 KB / 844-hunk patch. | https://registry.npmjs.org/@pierre/diffs |
| `@pierre/diffs` `dist/` | Source file | Shipped JS carries no `role` attributes (`aria-hidden` ×3, `aria-pressed` ×1, `tabIndex` ×4); header/annotation React content is projected through named `<slot>`s into light DOM; JS regex engine by default, oniguruma only under `preferredHighlighter: 'shiki-wasm'`. | https://www.npmjs.com/package/@pierre/diffs?activeTab=code |
| pierrecomputer/pierre #1076 | Issue | A worker that fails to load hangs `initialize()` forever while `isWorkingPool()` reports healthy, so nothing renders (closed 2026-08-28). | https://github.com/pierrecomputer/pierre/issues/1076 |
| "On Rendering Diffs" (Pierre, 2026-05-29) | Benchmark | Inverse-sticky virtualization + worker-pool highlighting; memory 2.4 GB → 1.15 GB on the Linux v6→v7 diff; no horizontal virtualization for very long lines. | https://pierre.computer/writing/on-rendering-diffs |
| `react-diff-view` | Registry | 3.3.3 (2026-03-30) is the only release in 12 months; MIT; 280,839 weekly downloads; bundles diff-match-patch and gitdiff-parser 0.3.1 inline. | https://registry.npmjs.org/react-diff-view |
| otakustay/react-diff-view #237 | Issue | "Virtualization for diffs" is open (updated 2026-06-26) — the library renders every hunk row. | https://github.com/otakustay/react-diff-view/issues/237 |
| `react-diff-view` SSR at 10k lines | Measured (ours) | Unified render of the 10k-line diff emits 25,353 `<td>` / 8,451 `<tr>` in 292 ms (3.0 MB HTML); `parseDiff` throws on jsdiff's `Index:`-headed patch and accepts it once prefixed `diff --git`. | https://github.com/otakustay/react-diff-view |
| MrWangJustToDo/git-diff-view #58 | Issue | `@git-diff-view/lowlight` eagerly imports all highlight.js languages, adding ~870 KB to the bundle (open). | https://github.com/MrWangJustToDo/git-diff-view/issues/58 |
| `@git-diff-view/core` bundle + CSS | Measured (ours) | `core` alone is 1,112 KB min / 315 KB gz (1,203 / 338 with `react`); `styles/diff-view.css` is 26 KB of Tailwind utilities under `.diff-tailwindcss-wrapper`; no virtualization primitive in `dist` (ResizeObserver only). | https://registry.npmjs.org/@git-diff-view/core |
| rtfpessoa/diff2html #534 | Issue | "Way to split up large diff" closed without a virtualization mechanism; `Diff2HtmlUI` measured at 1,110 KB / 322 KB gz because it bundles highlight.js. | https://github.com/rtfpessoa/diff2html/issues/534 |
| Aeolun/react-diff-viewer-continued #52 | Issue | Detached `data-emotion="react-diff"` style nodes cause slowness (open since 2024-08). | https://github.com/Aeolun/react-diff-viewer-continued/issues/52 |
| react-diff-viewer-continued v4.1.0 | Changelog | `infiniteLoading` paging virtualization introduced 2026-02-04; inputs remain `oldValue`/`newValue` strings only; eager bundle measured 155 KB / 53 KB gz including js-yaml and emotion. | https://github.com/Aeolun/react-diff-viewer-continued/releases/tag/v4.1.0 |
| CodeMirror migration to Forgejo | Docs | GitHub `codemirror/*` repos archived; canonical repos live at code.haverbeke.berlin since 2026-04-15; npm publishing continues. | https://discuss.codemirror.net/t/codemirrors-migration-to-forgejo/9706 |
| `@codemirror/merge` `dist/index.d.ts` | Source file | `MergeView` takes whole documents `{ a, b }` and `unifiedMergeView` takes `original` — no patch input; `DiffConfig { scanLimit, timeout }`; raw `diff()` measured at 6,906 ms on two 500 KB documents. | https://registry.npmjs.org/@codemirror/merge |
| `monaco-editor` bundle | Measured (ours) | `export * from 'monaco-editor'` (0.56.0) eager 3,848 KB min / 989 KB gz JS plus 1,597 KB CSS (253 KB gz); prebuilt `min/vs/editor-*.js` alone 2,389 KB / 594 KB gz. | https://registry.npmjs.org/monaco-editor |
| jsdiff release notes | Changelog | v9 `parsePatch` handles git extended headers (create/delete/rename/mode); v8 added `timeout`, `maxEditLength`, `oneChangePerToken`; GHSA-73rr-hh4g-fpgx backported to 3.5.1 / 4.0.4 / 5.2.2. | https://github.com/kpdecker/jsdiff/blob/master/release-notes.md |
| `diff` (jsdiff) 9.0.0 | Measured (ours) | 9.0.0 (2026-04-13, BSD-3-Clause): `parsePatch` 2.1 ms on an 898 KB patch, `diffLines` 273 ms on 10k × 10k lines, `diffWordsWithSpace` 17.6 ms on 992 changed-line pairs; 11 KB / 4.3 KB gz for those three functions. | https://registry.npmjs.org/diff |
| `diff-match-patch` (Google) | Registry | npm 1.0.5 last published 2020-05-20, untyped; the upstream google/diff-match-patch repository was archived 2024-05-22. | https://registry.npmjs.org/diff-match-patch |
| `@tanstack/react-virtual` | Registry | 3.14.10 (2026-08-18), MIT, peer react up to `^19.0.0`, `sideEffects: false`, 25 releases in 12 months; measured 23 KB / 7.2 KB gz. | https://registry.npmjs.org/@tanstack/react-virtual |
| TanStack/virtual #1262 | Issue | `measureElement(el)` does not update item size when element height changes dynamically (open, updated 2026-08-31). | https://github.com/TanStack/virtual/issues/1262 |
| Spec-023 §Security Hardening Baseline | Spec | Renderer CSP is `style-src 'self' 'unsafe-inline'`, `script-src 'self'`, with no `worker-src` — style-injecting libraries and same-origin module workers are admissible. | https://github.com/Sawmonabo/ai-sidekicks/blob/develop/docs/specs/023-desktop-shell-and-renderer.md |
| shiki JS-engine tokenization | Measured (ours) | `codeToTokensBase` over 10k TypeScript lines takes 1,960 ms and +84.5 MB heap on the main thread; fine-grained bundle with the TypeScript grammar is 348 KB / 70 KB gz. | https://registry.npmjs.org/shiki |

**D.4 Node-graph builder**

| Source | Type | Key Finding | URL |
| --- | --- | --- | --- |
| `@xyflow/react` registry record | Registry | Latest 12.11.6 published 2026-09-01T12:07Z, 16 releases since 2025-09-01, license MIT, peers `react >=17` / `react-dom >=17`, deps `@xyflow/system@0.0.82`, `zustand@^4.4.0`, `classcat@^5.0.3`. | https://registry.npmjs.org/@xyflow/react/latest |
| `@xyflow/react` weekly downloads | Registry | 11,233,170 downloads in the week 2026-08-23..29. | https://api.npmjs.org/downloads/point/last-week/@xyflow/react |
| xyflow `LICENSE` | Source file | Plain MIT text ("Copyright (c) 2019-2025 webkid GmbH") with no attribution-mark clause. | https://github.com/xyflow/xyflow/blob/main/LICENSE |
| xyflow PR #5866 "React Flow 13 and Svelte Flow 2" | PR | Draft v13 sets minimum zustand 5 and React 18 and replaces the `onNodesChange` / `onEdgesChange` change arrays with `NodeChangeset` / `EdgeChangeset` classes (breaking for controlled mode). | https://github.com/xyflow/xyflow/pull/5866 |
| xyflow issue #5685 | Issue | Forcing zustand 4.x and 5.x into one copy produced runtime `TypeError: ... is not a function`; still open (2026-07-01) — never alias or dedupe `zustand`. | https://github.com/xyflow/xyflow/issues/5685 |
| xyflow issue #5980 | Issue | 12.11.4 shipped importing `handleAttributionWarning` that `@xyflow/system@0.0.80` lacked; fixed by 12.11.5 the same day — pin both packages in lockstep. | https://github.com/xyflow/xyflow/issues/5980 |
| React Flow `<ReactFlow />` API reference | Docs | `isValidConnection`: "If you return `false`, the edge will not be added to your flow"; `onlyRenderVisibleElements` default `false`; `deleteKeyCode` default `'Backspace'` and `panActivationKeyCode` `'Space'`, all nullable. | https://reactflow.dev/api-reference/react-flow |
| `@xyflow/system@0.0.82` dist (`XYHandle.isValid`) | Source file | `isValidHandle` sets `result.isValid = isValid && isValidConnection(connection)` on every pointer move during the drag, while `addEdges` only queues `[...edges, ...newEdges]` with no validation. | https://registry.npmjs.org/@xyflow/system/0.0.82 |
| React Flow accessibility guide | Docs | Tab focuses nodes/edges, Enter/Space selects, Escape clears, arrow keys move (Shift faster), Delete removes; no keyboard edge creation is documented. | https://reactflow.dev/learn/advanced-use/accessibility |
| React Flow `ProOptions` + Pro pricing | Docs | Policy "attribution visible, no subscription needed; no attribution, please subscribe" via `hideAttribution: boolean`; removal permitted on any Pro tier — Starter $169/month, Professional $289/month, Enterprise custom (https://reactflow.dev/pro). | https://reactflow.dev/api-reference/types/pro-options |
| React Flow theming guide | Docs | `base.css` styles "are required for React Flow to function correctly"; visuals are driven by `--xy-*` variables and `colorMode` only adds a class to `.react-flow`. | https://reactflow.dev/learn/customization/theming |
| `@xyflow/react` CHANGELOG | Changelog | 12.10.1 (#5704) keeps `isValidConnection` current during an ongoing connection; 12.11.4 (#5962) logs a dev-only warning when the attribution is hidden; 12.11.2 (#5846 / #5847) applies the viewport transform imperatively and stops MiniMap re-rendering on every store update. | https://github.com/xyflow/xyflow/blob/main/packages/react/CHANGELOG.md |
| Bundle-size measurement (esbuild, react externals) | Measured (ours) | Full surface 180,202 B min / 59,445 B gzip, core subset 179,942 B (260 B saved), `base.css` 13,585 B; Bundlephobia corroborates at 187,694 B / 59,920 B gzip. | https://bundlephobia.com/package/@xyflow/react@12.11.6 |
| Headless-Chrome render measurement (React 19.2.8, Chrome 152) | Measured (ours) | 200 nodes / 261 edges: 9.1 MB JS heap after GC, 2,898 DOM nodes, 31 rAF frames in a 516 ms drag, zero console errors or warnings; 1,000 nodes: 33.5 MB (the vendor stress example renders a 15 × 30 = 450-node grid). | https://reactflow.dev/examples/nodes/stress |
| `elkjs` registry record | Registry | 0.12.0 published 2026-07-17, license `EPL-2.0 OR GPL-3.0-or-later`, 3 releases in 12 months, unpacked 8.0 MB. | https://registry.npmjs.org/elkjs/latest |
| elkjs issue #158 (and #312) | Issue | Maintainer: "There are no plans towards dual licensing" (2022-01-09); the 2024–2026 relicensing thread #312 remains open. | https://github.com/kieler/elkjs/issues/158 |
| ELK `randomSeed` option | Docs | "If the value is 0, the seed shall be determined pseudo-randomly (e.g. from the system time)"; the layered algorithm's default seed is 1. | https://eclipse.dev/elk/reference/options/org-eclipse-elk-randomSeed.html |
| React Flow layouting guide | Docs | elkjs is "~1.4MB" and "We don't often recommend elkjs because its complexity makes it difficult for us to support folks"; dagre is "~39.9KB" and "largely a drop-in solution". | https://reactflow.dev/learn/layouting/layouting |
| `@dagrejs/dagre` registry record | Registry | 3.1.1 published 2026-08-08, MIT, 8 releases in 12 months including majors 2.0.0 (2025-11-20) and 3.0.0 (2026-03-22), ESM `type: module` with bundled types, 4,240,852 weekly downloads. | https://registry.npmjs.org/@dagrejs/dagre/latest |
| dagre PR #512 "Dynamic graph support" (with fix PR #515) | PR | 3.1.0 makes `layout()` keep order and rank between graph versions and "Can be disabled by passing useDynamic = false" (on by default); 3.1.1 (#515) moved the remembered state from module variables to a `WeakMap` keyed by the input graph after cross-graph leakage. | https://github.com/dagrejs/dagre/pull/512 |
| `dagre` (legacy) registry record | Registry | 0.8.5 last published 2019-12-03 with `lodash` and `graphlib@^2.1.8` dependencies; 0 releases in 12 months. | https://registry.npmjs.org/dagre/latest |
| `d3-dag` registry record + README | Registry | 1.2.2 published 2026-07-05, MIT, deps `javascript-lp-solver` and `quadprog`, 52,898 weekly downloads; the README rates the default "medium" preset ≈ 2× slower than dagre v3 and "fast" ≈ 4× faster. | https://registry.npmjs.org/d3-dag/latest |
| graphology standard-library layout docs | Docs | Layouts offered are circular, random, circlepack, force, forceatlas2 and noverlap — no layered, hierarchical or Sugiyama layout; `graphology-layout` last published 2022-09-20. | https://graphology.github.io/standard-library/layout.html |
| Layout determinism + quality benchmark (dagre 3.1.1, d3-dag 1.2.2, elkjs 0.12.0, own) | Benchmark | On phase-sequence DAGs all four produced identical coordinate hashes across two processes and zero crossings/overlaps; at 200 nodes best times were own 0.3 ms, d3-dag 21.5 ms, dagre 31.1 ms, elkjs 48–51 ms, with own matching dagre's 44,080 × 472 extent and ELK 2,415 tall. | https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html |
| Spec-017 §Visual Workflow Builder (SA-32, SA-35) and ADR-026 | Spec | The graph is the phase set plus one entry node with the sequence edge as the sole edge kind, layout is excluded from the hashed body and persists client-local, and a layout-less definition renders through "a deterministic topological auto-layout derived from the phase sequence". | docs/specs/017-workflow-authoring-and-execution.md |

**D.5 Terminal**

| Source | Type | Key Finding | URL |
| --- | --- | --- | --- |
| `@xterm/xterm` packument | Registry | Latest 6.0.0 published 2025-12-22 (MIT); 330 publishes since 2025-09-01, all but one on the 6.1.0-beta train (beta.304 on 2026-08-30); 4,305,354 weekly downloads for 2026-08-23..29. | https://registry.npmjs.org/@xterm%2Fxterm/latest |
| xterm.js 6.0.0 release notes | Changelog | 6.0 removed the canvas renderer (DOM or WebGL only), added ESM builds, Shadow DOM WebGL support, DEC 2026 synchronized output, and SearchLineCache. | https://github.com/xtermjs/xterm.js/releases/tag/6.0.0 |
| `@xterm/xterm` 6.0.0 + `@xterm/addon-webgl` 0.19.0 tarballs | Measured (ours) | `lib/xterm.mjs` is 344,970 B raw and 88,009 B gzip; `lib/addon-webgl.mjs` is 126,558 B raw and 35,811 B gzip; the full pane (core + css + webgl + fit + search + unicode11 + serialize) is about 155 KB gzip. | https://registry.npmjs.org/@xterm/xterm/-/xterm-6.0.0.tgz |
| `@xterm/headless` 6.0.0 memory and throughput probe (Node 24.18.0, macOS arm64) | Measured (ours) | A 120-column, 10,000-line-scrollback instance costs 18.2 MiB heap plus ArrayBuffers (13.8 MiB in ArrayBuffers, consistent with 12 B per cell), ingests SGR-dense text at 17.6 MB/s, and serializes in 86 ms to 1.92 MB. | https://registry.npmjs.org/@xterm%2Fheadless/latest |
| xterm.js `BufferLine.ts` | Source file | Each line eagerly allocates `new Uint32Array(cols * CELL_INDICIES)` with `CELL_INDICIES = 3`, so buffer memory is 12 bytes per cell regardless of content. | https://github.com/xtermjs/xterm.js/blob/master/src/common/buffer/BufferLine.ts |
| xterm.js `WebglRenderer.ts` | Source file | The renderer requests `webgl2` and throws `WebGL2 not supported` when unavailable, fires `onContextLoss` 3 s after `webglcontextlost` without restoration, and shares the glyph atlas across instances via `acquireTextureAtlas`. | https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/src/WebglRenderer.ts |
| Chromium `webgraphicscontext3d_provider_impl.cc` | Source file | `prefs.max_active_webgl_contexts = 16u` on desktop (8 on Android, 4 on workers); Blink forcibly loses the oldest context past the cap, overridable by the `--max-active-webgl-contexts` switch. | https://github.com/chromium/chromium/blob/main/content/renderer/webgraphicscontext3d_provider_impl.cc |
| xterm.js issue #6068 | Issue | `WebglAddon.dispose()` does not release the WebGL2 context, so about 16 create/dispose cycles make a still-live terminal lose its renderer (reproduced on Electron 30+). | https://github.com/xtermjs/xterm.js/issues/6068 |
| xterm.js issue #6015 | Issue | The WebGL renderer floors device char width and the DOM renderer does not, so a runtime renderer swap reflows the grid by up to about 1 device px per cell. | https://github.com/xtermjs/xterm.js/issues/6015 |
| xterm.js issue #6113 | Issue | Cursor blink never starts on 6.1.0-beta in a headless Xvfb Electron environment while 6.0.0 works, which is why the pin is 6.0.0 stable rather than the beta train. | https://github.com/xtermjs/xterm.js/issues/6113 |
| xterm.js `Terminal.ts` (public API) | Source file | Only the `unicode` getter calls `_checkProposedApi()`; `registerLinkProvider`, `registerDecoration`, `registerMarker`, `buffer`, and `onWriteParsed` need no `allowProposedApi`. | https://github.com/xtermjs/xterm.js/blob/master/src/browser/public/Terminal.ts |
| xterm.js `AccessibilityManager.ts` | Source file | `screenReaderMode` exposes rows as `role="list"` / `role="listitem"` with an `aria-live="assertive"` region and a `MAX_ROWS_TO_READ = 20` flood guard. | https://github.com/xtermjs/xterm.js/blob/master/src/browser/AccessibilityManager.ts |
| xterm.js `typings/xterm.d.ts` | Docs | `registerLinkProvider(provider): IDisposable` and the `linkHandler: ILinkHandler` option (`activate` / `hover` / `leave` / `allowNonHttpProtocols`) give the embedder full control of link detection; the doc comment warns a program can emit `javascript:` links and the handler must validate schemes. | https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts |
| `@xterm/addon-canvas` packument | Registry | Latest 0.7.0 was published 2024-04-05 against peer `@xterm/xterm ^5.0.0` with zero releases in the last 12 months; the renderer was removed in 6.0. | https://registry.npmjs.org/@xterm%2Faddon-canvas/latest |
| `react-xtermjs` repository `LICENSE` | Source file | The repository license file is GPL-3.0 while `package.json` 1.0.12 declares ISC (peer `@xterm/xterm ^5.5.0` or `^6.0.0`). | https://github.com/Qovery/react-xtermjs/blob/main/LICENSE |
| `xterm-for-react` packument | Registry | Latest 1.0.4 was published 2020-05-19 with dependency `xterm ^4.5.0` and peer `react ^16.0.0`; 2,631 weekly downloads. | https://registry.npmjs.org/xterm-for-react/latest |
| `ghostty-web` packument | Registry | Latest stable 0.4.0 was published 2025-12-09 (MIT); all 80 later publishes are `0.4.0-next.*` prereleases (last 2026-06-28); 752,620 weekly downloads. | https://registry.npmjs.org/ghostty-web/latest |
| `ghostty-web` 0.4.0 tarball | Measured (ours) | `dist/ghostty-web.js` is 681,918 B raw and 192,619 B gzip and embeds the 423,045 B wasm as a base64 `data:` URI; the bundle calls only `getContext("2d")`, and `index.d.ts` exposes no search, serialize, or `screenReaderMode` API. | https://registry.npmjs.org/ghostty-web/-/ghostty-web-0.4.0.tgz |
| ghostty-web issue #187 | Issue | Terminal output has no accessible representation (no screen-reader mode), filed 2026-08-01 and open. | https://github.com/coder/ghostty-web/issues/187 |
| ghostty-web issue #188 | Issue | The wasm loads through a `data:` URI fetch that `connect-src 'self'` blocks, and `init()` offers no wasm path override. | https://github.com/coder/ghostty-web/issues/188 |
| wterm README (vercel-labs) | Docs | wterm renders to the DOM, ships a ~12 KB Zig core or a ~400 KB libghostty backend, and themes through CSS custom properties with built-in themes in its stylesheet; `@wterm/*` is at 0.3.4 (2026-08-13) with a first publish on 2026-04-15. | https://github.com/vercel-labs/wterm |
| `anser` packument | Registry | Latest 2.3.5 published 2025-12-15 (MIT); 14,986,343 weekly downloads; `lib/index.js` is 23,234 B raw and 5,205 B gzip. | https://registry.npmjs.org/anser/latest |
| `anser` `lib/index.js` | Source file | `escapeForHtml` "should be run prior to `ansiToHtml`", so `ansiToHtml` does not escape by itself; `ansiToJson` emits structured chunks and no HTML. | https://github.com/IonicaBizau/anser/blob/master/lib/index.js |
| `ansi_up` README | Docs | `escape_html` defaults to true, `url_allowlist` defaults to `{ http, https }`, and `use_classes` yields `ansi-*-fg/bg` classes while bold, faint, italic, and underline stay inline styles. | https://github.com/drudru/ansi_up |
| `ansi-to-react` packument | Registry | Latest 6.2.6 published 2026-01-24 (BSD-3-Clause) depends on `anser ^2.3.2`, `linkify-it ^3.0.3`, and `escape-carriage`, with a React 19 peer range. | https://registry.npmjs.org/ansi-to-react/latest |
| linkify-it advisory GHSA-22p9-wv53-3rq4 | Issue | `LinkifyIt#match` has quadratic complexity, fixed only in 5.0.1 (2026-06-26); a second `mailto:` DoS (GHSA-v245-v573-v5vm) is fixed only in 5.0.2, so a `^3.0.3` pin can never resolve to a fixed release. | https://github.com/advisories/GHSA-22p9-wv53-3rq4 |
| `ansi-to-html` `lib/ansi_to_html.js` | Source file | The default options set `escapeXML: false`, and `pushText` only encodes entities when that option is set, so output is unescaped by default. | https://github.com/rburns/ansi-to-html/blob/master/lib/ansi_to_html.js |
| `ansi-to-html` packument | Registry | Latest 0.7.2 was published 2021-10-05 with no release since; 2,303,513 weekly downloads and 29 open issues. | https://registry.npmjs.org/ansi-to-html/latest |

**D.6 Layout, panes, drag, toasts**

| Source | Type | Key Finding | URL |
| --- | --- | --- | --- |
| react-resizable-panels | Registry | 4.12.3 published 2026-08-16, 86 versions since 2025-09-01, MIT, peers react and react-dom at ^18 or ^19, zero runtime deps. | https://registry.npmjs.org/react-resizable-panels |
| react-resizable-panels 4.12.3 dist | Measured (ours) | `export *` bundles to 34.3 kB min / 11.7 kB gzip with React external, ships no CSS, and the dist drives the drag with `setPointerCapture` and `flexGrow` writes. | https://registry.npmjs.org/react-resizable-panels/-/react-resizable-panels-4.12.3.tgz |
| react-resizable-panels #740 | Issue | At 4.12.3 every Separator after the first has `aria-valuemin` / `aria-valuemax` swapped; open since 2026-08-28 with PR #741 pending. | https://github.com/bvaughn/react-resizable-panels/issues/740 |
| react-resizable-panels #720 | Issue | A pixel `minSize` scales like a percentage on window resize (reported on 4.11.2); open and unanswered. | https://github.com/bvaughn/react-resizable-panels/issues/720 |
| WAI-ARIA APG Window Splitter | Spec | A focusable splitter is `role="separator"` with `aria-valuenow/min/max` and `aria-controls`, moved by arrow keys with Home/End/Enter — the bar rrp meets and allotment does not. | https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/ |
| dockview 8.2.0 | Measured (ours) | `export *` is 381.5 kB min / 89.3 kB gzip plus a required `dockview.css` of 150.3 kB raw / 12.4 kB gzip defining 125 `--dv-*` variables and 18 theme classes. | https://registry.npmjs.org/dockview |
| dockview #1596 | Issue | `PositionCache` kept detached panel DOM for the component's lifetime: +360 MB per add/remove round under `renderer: 'always'`; fixed in 8.1.0 (2026-08-12). | https://github.com/dockview/dockview/issues/1596 |
| dockview v8 release notes | Docs | v8 introduces the separately-licensed `dockview-enterprise` package while the free packages stay MIT; reported panel dimensions now exclude the header. | https://dockview.dev/docs/releases/whats-new/whats-new-v8 |
| flexlayout-react CHANGELOG | Changelog | Breaking changes shipped in 0.9.0 (2026-04-25) and 0.10.6 (2026-08-25); ARIA and keyboard support arrived only in 0.10.0 (2026-07-14); measured 53.1 kB gzip plus a required theme stylesheet. | https://github.com/caplin/FlexLayout/blob/master/CHANGELOG.md |
| rc-dock | Registry | `latest` is 4.0.0-alpha.2 (2025-09-04) with three alpha tags since 2025-09-01, depending on `@rc-component/menu`, `tabs`, `dropdown` and `lodash`. | https://registry.npmjs.org/rc-dock |
| allotment 1.20.5 dist | Source file | `dist/modern.mjs` and `dist/module.js` contain zero `role`, `aria-`, `keydown`, or `tabindex` tokens — the sash is mouse-only. | https://registry.npmjs.org/allotment/-/allotment-1.20.5.tgz |
| react-mosaic-component | Registry | 7.0.0 depends on `react-dnd ^16.0.1` plus `dnd-core`, `react-dnd-html5-backend`, `-multi-backend`, `-touch-backend`, and requires its stylesheet. | https://registry.npmjs.org/react-mosaic-component |
| react-dnd | Registry | 16.0.1 was published 2022-04-19 with nothing since; the repository has one commit since 2025-01-01. | https://registry.npmjs.org/react-dnd |
| dnd-kit discussion #1803 | Issue | Maintainer (2025-09-22): all development effort goes to next.dndkit.com; the next version "is production ready" but "some APIs may change in the future before the 1.0.0 release"; `@dnd-kit/core` has had zero releases since 2025-09-01. | https://github.com/clauderic/dnd-kit/discussions/1803 |
| dnd-kit #2116 | Issue | Under React 19 StrictMode the `@dnd-kit/react` `DragDropProvider` manager is destroyed during the development effect replay; open since 2026-07-31. | https://github.com/clauderic/dnd-kit/issues/2116 |
| @dnd-kit/react 0.5.0 | Measured (ours) | react + sortable bundle to 118.0 kB min / 38.9 kB gzip, 2.2× the legacy core+sortable+utilities at 17.4 kB gzip. | https://registry.npmjs.org/@dnd-kit/react |
| @atlaskit/pragmatic-drag-and-drop 3.1.0 | Measured (ours) | Element adapter + `combine` is 22.0 kB min / 6.9 kB gzip; with hitbox closest-edge, auto-scroll, live-region and preview helpers 36.3 kB / 10.6 kB gzip; no CSS in any of them. | https://registry.npmjs.org/@atlaskit/pragmatic-drag-and-drop |
| pragmatic-drag-and-drop CHANGELOG | Changelog | 3.0.0 (2026-08-14) added direct entry paths and kept legacy paths as deprecated shims; 2.0.0 (2026-06-16) made TypeScript 5 the minimum; 1.8.0 moved previews onto `popover="manual"`. | https://github.com/atlassian/pragmatic-drag-and-drop/blob/main/packages/core/CHANGELOG.md |
| pragmatic-drag-and-drop accessibility guidelines | Docs | No keyboard drag-and-drop by design ("Avoid directional controls"); the same outcomes are to be offered through accessible buttons, menus, and forms plus live-region announcements. | https://atlassian.design/components/pragmatic-drag-and-drop/accessibility-guidelines/ |
| @floating-ui/dom 1.8.0 and @floating-ui/react 0.27.20 | Measured (ours) | dom positioning subset 18.2 kB min / 7.3 kB gzip; react-dom `useFloating` 7.4 kB gzip; react popover hook subset 61.1 kB / 22.1 kB gzip; full react 32.7 kB gzip; no CSS. | https://registry.npmjs.org/@floating-ui/dom |
| floating-ui #3260 | Issue | `@floating-ui/react` v1 is planned to stabilize APIs and shrink the bundle; `core`, `dom`, and `react-dom` will get no new majors. | https://github.com/floating-ui/floating-ui/issues/3260 |
| react-aria 3.52.0 overlays | Measured (ours) | The `useOverlayPosition` / `useOverlay` / `usePopover` / `Overlay` subset is 55.6 kB min / 19.1 kB gzip, 2.6× `@floating-ui/dom`, pulling in `react-stately` and `@internationalized/*`. | https://registry.npmjs.org/react-aria |
| sonner 2.0.8 dist | Source file | `dist/index.mjs` calls `__insertCSS` at import, appending a `<style>` with the full stylesheet to `<head>` regardless of the `unstyled` prop. | https://registry.npmjs.org/sonner/-/sonner-2.0.8.tgz |
| react-hot-toast | Registry | 2.6.0 published 2025-08-15 with zero releases since 2025-09-01 and a last commit on 2025-08-16; its headless entry measures 3.8 kB min / 1.7 kB gzip. | https://registry.npmjs.org/react-hot-toast |
| Electron web-embeds guide and View API | Docs | A WebContentsView is "not a part of the DOM — instead, they are created, controlled, positioned, and sized by your Main process"; `View.setBounds` / `getBounds` are parent-relative and later `addChildView` children draw on top. | https://www.electronjs.org/docs/latest/tutorial/web-embeds |

**D.7 Headless UI primitives, keybindings, palette, accessibility**

| Source | Type | Key Finding | URL |
| --- | --- | --- | --- |
| `@base-ui/react` | Registry | 1.7.0 published 2026-08-04; peer React `^17 \|\| ^18 \|\| ^19`; `date-fns` / `@date-fns/tz` peers are optional; 83 subpath exports; the tarball ships 0 CSS files. | https://registry.npmjs.org/@base-ui%2Freact/latest |
| Base UI Combobox docs | Docs | Combobox exposes `filter` (function or `null`), `virtualized`, `inline`, `multiple`, `Group`; free-text entry is the sibling `Autocomplete` — the family covers the palette/composer widget natively. | https://base-ui.com/react/components/combobox |
| Base UI #4678 | Issue | Modal Dialog applies `aria-hidden` to the background but leaves it tabbable; open since 2026-04-24 (maintainer points at Floating UI's `outsideElementsInert`). | https://github.com/mui/base-ui/issues/4678 |
| Console-set bundle (esbuild, React external, gzip -9) | Measured (ours) | Gzip bytes for the full primitive set: Radix 42,440 (no combobox), Ariakit 51,889 (no slider), Headless UI 63,506 (no tooltip/slider/context), RAC 80,918 with 34 locales → 72,136 en-US only, Base UI 89,578 (complete); no candidate loads WASM or a Worker. | https://bundlephobia.com/package/@base-ui/react@1.7.0 |
| Radix #1342 | Issue | The Combobox primitive request was closed 2025-01-25 (`state_reason: completed`) with no primitive shipped; commenters point at shadcn's Popover + cmdk composition. | https://github.com/radix-ui/primitives/issues/1342 |
| Radix #3694 | Issue | Opening a Radix Dialog makes a Base UI Combobox/Autocomplete unselectable — two overlay families in one tree break each other. | https://github.com/radix-ui/primitives/issues/3694 |
| Radix #4091 (Railing conformance run) | Benchmark | 50/50 APG/WCAG assertions pass on Dialog, dropdown Menu, Tabs, Accordion at default configuration; Combobox scored n/a because Radix does not ship one. | https://github.com/radix-ui/primitives/issues/4091 |
| React Aria quality page | Docs | Tested with VoiceOver on macOS (Safari, Chrome) and iOS, JAWS and NVDA on Windows (Firefox, Chrome), and TalkBack on Android — the only vendor-documented screen-reader matrix among the candidates. | https://react-aria.adobe.com/quality |
| react-spectrum #10395 | Issue | FocusScope's Tab interception blocks keyboard scrolling of scroll containers inside a modal Dialog (WCAG 2.1.1); open since 2026-07-30, maintainer says the fix PR is stale. | https://github.com/adobe/react-spectrum/issues/10395 |
| React Aria v1.17.0 release notes | Changelog | Individual `@react-aria/*` packages (e.g. `@react-aria/live-announcer` 3.5.1, which declares `react-aria ^3.48.0`) now re-export from the `react-aria` monopackage; our install measured `react-aria` at 37 MB. | https://react-aria.adobe.com/releases/v1-17-0 |
| Ariakit #2100 | Issue | "Feature Request: Slider component" open since 2022-12-05 with no implementation while the library sits at 0.4.38. | https://github.com/ariakit/ariakit/issues/2100 |
| Headless UI component list | Docs | The React catalogue has Menu, Dialog, Popover, Tabs, Switch, Combobox, Listbox and no Tooltip, Slider, or Context Menu; npm latest 2.2.10 dates from 2026-04-07. | https://headlessui.com/ |
| `cmdk` | Registry | 1.1.1 published 2025-03-14 with zero releases in the following 12 months; runtime deps include `@radix-ui/react-dialog`. | https://registry.npmjs.org/cmdk/latest |
| cmdk #373 | Issue | `aria-activedescendant` is sometimes missing on the active item; open since 2025-07-09. | https://github.com/dip/cmdk/issues/373 |
| kbar `lib/KBarAnimator.js` (1.0.0) | Source file | `KBarAnimator` merges `appearanceAnimationKeyframes[0]` and `pointerEvents: "auto"` into the element's inline `style` — motion identity shipped by the library; the package is CJS-only with no `exports` map. | https://unpkg.com/kbar@1.0.0/lib/KBarAnimator.js |
| tinykeys README | Docs | `tinykeys`, `createKeybindingsHandler`, `parseKeybinding`; syntax `$mod+K`, `Control+[Shift]+D`, `KeyD`, sequences `g i`; ~1 KB; no scopes or when-clauses (4.0.0 published 2026-05-20). | https://github.com/jamiebuilds/tinykeys |
| react-hotkeys-hook #1058 | Issue | Scoped hotkeys still trigger when their scope is not active; open since 2024-10-21. | https://github.com/JohannesKlauss/react-hotkeys-hook/issues/1058 |
| `focus-trap-react` | Registry | 12.0.3 (2026-06-22) is CJS-only (`main: dist/focus-trap-react.js`, no `module`, no `exports`) and duplicates the focus manager every primitives family already ships. | https://registry.npmjs.org/focus-trap-react/latest |
| `axe-core` | Registry | 4.13.0 published 2026-08-05 under **MPL-2.0** — outside the brief's MIT/Apache/BSD/ISC list, so flagged; dev-only, never bundled. | https://registry.npmjs.org/axe-core/latest |
| axe-core-npm #1141 | Issue | `new AxeBuilder({ page }).analyze()` against an Electron app fails with `Protocol error (Target.createTarget): Not supported`; the reporter confirms legacy mode works; open since 2024-11-27. | https://github.com/dequelabs/axe-core-npm/issues/1141 |
| happy-dom #978 | Issue | axe-core throws `Cannot set property isConnected … which has only a getter` under happy-dom; open since 2023-07-11 with no fix as of 2026-04-24 — blocks unit-level axe in the renderer's happy-dom 19 environment. | https://github.com/capricorn86/happy-dom/issues/978 |
| `vitest-axe` | Registry | `latest` is 0.1.0 (2022-10-21); the only newer tag is `1.0.0-pre.5` (2025-01-22). | https://registry.npmjs.org/vitest-axe |
| `eslint-plugin-jsx-a11y` | Registry | 6.10.2 (2024-10-26) declares peer `eslint ^3 \|\| … \|\| ^9` — no `^10`, so it does not install against this repo's ESLint `^10.2.1`. | https://registry.npmjs.org/eslint-plugin-jsx-a11y/latest |
| `eslint-plugin-jsx-a11y-x` | Registry | 0.2.0 (2026-05-10), MIT, peer `eslint ^9.0.0 \|\| ^10.0.0`, es-tooling fork with the same rule set under the `jsx-a11y-x/` namespace. | https://registry.npmjs.org/eslint-plugin-jsx-a11y-x/latest |
| VS Code `src/vs/base/common/filters.ts` | Source file | `fuzzyScore` reference implementation for command-palette ranking, MIT, 31,136 bytes — the port target for the own-built scorer. | https://github.com/microsoft/vscode/blob/main/src/vs/base/common/filters.ts |

**D.8 State, storage, forms, search, dates**

| Source | Type | Key Finding | URL |
| --- | --- | --- | --- |
| zustand | Registry | 5.0.15 published 2026-08-13, MIT, peer `react >=18` (optional), 54.49 M weekly downloads, 58,633 stars, 2 open issues (5 opened / 5 closed in 6 months); measured 750 B gz for `create` + `useShallow`. | https://registry.npmjs.org/zustand/latest |
| Announcing Zustand v5 | Changelog | v5 (2024-10-20) dropped React < 18 and the `use-sync-external-store` shim and "now uses the native `useSyncExternalStore`", TS ≥ 4.5, ES5 dropped; selectors returning fresh references must use `useShallow`. | https://pmnd.rs/blog/announcing-zustand-v5 |
| Fan-out micro-benchmark | Measured (ours) | 20 000 entities / 300 mounted subscribers: one flat `Map` costs 1,302 µs per update, partitioned `Map<sessionId, Map<id>>` 57 µs, 50 events coalesced per frame 27 µs; jotai atom-per-entity 3.4 µs, valtio 15.4 µs; immer on a flat record 7,100 µs, partitioned 144 µs (Node 24.18.0, `zustand/vanilla`, `jotai/vanilla`, `valtio/vanilla`, `mobx`). | https://nodejs.org/dist/v24.18.0/ |
| Retained-heap measurement | Measured (ours) | Same 20 000 entities retain +3.9 MiB as a frozen `Map`, +29.4 MiB under valtio `proxy` (7.5×), +41.2 MiB under mobx `observable.map` deep (10.6×), +16.3 MiB as 20 000 jotai atoms (4.2×) (`node --expose-gc`). | https://nodejs.org/dist/v24.18.0/ |
| esbuild bundle measurement | Measured (ours) | min/gzip bytes with React external (esbuild 0.28.2, es2022, production define): zustand core 1,482/750; mobx+lite 46,556/13,634; immer 9,306/3,849; `@rjsf/core` Form 406,471/135,848; `@jsonforms/react` headless 225,067/74,892; ajv 123,448/37,970; vanilla-jsoneditor 1,064,466/320,254; CodeMirror minimal JSON 337,829/109,634; react-hook-form 38,711/13,856; fuse 26,548/9,577; ufuzzy 8,884/4,196; date-fns (7 fns) 26,824/8,278; `@js-temporal/polyfill` 162,095/46,869; temporal-polyfill 56,395/19,730; dexie 100,209/32,736; idb 3,346/1,380; zod classic 433,250/86,866. | https://esbuild.github.io/ |
| Valtio v2 migration guide | Docs | "In v2, it is an impure function and deeply modifies `obj`" (`proxy()`), React ≥ 18 with promises routed through React 19 `use`, `useSnapshot` re-render semantics changed for the React compiler. | https://github.com/pmndrs/valtio/blob/main/docs/guides/migrating-to-v2.mdx |
| MobX CHANGELOG 7.0.0 | Changelog | 7.0.0 (npm 2026-07-30) removed the ES5/non-proxy fallback and legacy decorators, converted namespaced APIs to named exports, requires `mobx-react-lite` 5 on React 18+; "ESM prod 17.02 KiB gzip → 13.96 KiB gzip". | https://github.com/mobxjs/mobx/blob/main/packages/mobx/CHANGELOG.md |
| @tanstack/react-store `useSelector` | Source file | 0.11.1 `useSelector` is `useSyncExternalStoreWithSelector` from `use-sync-external-store/shim/with-selector` with default compare `a === b`; `useStore` is a `@deprecated` alias; package still 0.x, 891 stars. | https://github.com/TanStack/store/blob/main/packages/react-store/src/useSelector.ts |
| immer v11.0.0 release | Changelog | 2025-11-23: finalization "rewritten to use a callback approach instead of tree traversal", ported from Mutative, loose iteration on by default, `assigned_` converted to `Map` — breaking; immer's own performance page rates it 2–3× a handwritten reducer worst case. | https://github.com/immerjs/immer/releases/tag/v11.0.0 |
| idb README | Docs | "~1.19kB brotli'd"; every `IDBRequest` becomes a promise, `for await` cursors, typed `DBSchema`; "Do not `await` other things between the start and end of your transaction" (auto-commit once microtasks drain); 8.0.3 published 2025-05-07 with 0 releases and 0 issue movement in 12 months, ISC. | https://github.com/jakearchibald/idb |
| idb-keyval custom-stores guide | Docs | "createStore won't let you create multiple stores within the same database. Nor will it let you create a store within an existing database" — and recommends `idb` for transactions and schema migrations. | https://github.com/jakearchibald/idb-keyval/blob/main/custom-stores.md |
| Dexie.js + localForage repositories | Registry | dexie 4.4.5 (2026-08-14), Apache-2.0, 576 open issues, measured 32.7 kB gz, Dexie Cloud is a separate paid backend; localforage 1.10.0 last published 2021-08-18, repo last pushed 2024-07-30, README still documents the WebSQL driver. | https://github.com/dexie/Dexie.js |
| Electron `protocol` API | Docs | "By default web storage apis (localStorage, sessionStorage, webSQL, indexedDB, cookies) are disabled for non standard schemes"; `registerSchemesAsPrivileged` "can only be used before the `ready` event of the `app` module gets emitted and can be called only once" — the `sidekicks://` renderer has no IndexedDB until registered `standard: true`. | https://www.electronjs.org/docs/latest/api/protocol |
| Spec-023 §Security Hardening Baseline | Spec | Renderer CSP is `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'` and "strict CSP (no `eval`, no inline scripts, no `unsafe-eval`)" — disqualifies every runtime-codegen validator. | https://github.com/Sawmonabo/ai-sidekicks/blob/develop/docs/specs/023-desktop-shell-and-renderer.md |
| Ajv security page + compiler source | Docs | "When using Ajv in a browser page with enabled Content Security Policy (CSP), `script-src` directive must include `'unsafe-eval'`"; the compiler builds validators with `new Function(...)` (the compiler's `dist/compile/index.js`); the only workaround is build-time standalone code, impossible for runtime workflow schemas. | https://ajv.js.org/security.html |
| @rjsf/core `lib/index.js` (6.8.0) | Source file | The core entry re-exports `getTestRegistry`, which imports `@rjsf/validator-ajv8`, so Ajv (206 KiB unminified) ships with `Form` alone — 135,848 B gz measured; v6 requires React ≥ 18 / Node ≥ 20 and 27+ overridable templates to purge `rjsf-` markup. | https://github.com/rjsf-team/react-jsonschema-form/blob/main/packages/core/src/index.ts |
| @jsonforms/core reducer (3.8.0) | Source file | The INIT reducer runs `thisAjv.compile(action.schema)` unless `validationMode === 'NoValidation'` (`jsonforms-core.esm.js:1319–1321`), and the headless entry bundles full lodash + Ajv (74,892 B gz measured). | https://github.com/eclipsesource/jsonforms/blob/master/packages/core/src/reducers/core.ts |
| Zod JSON Schema docs + local `fromJSONSchema` run | Docs | `z.fromJSONSchema()` "is experimental and is not considered part of Zod's stable API"; shipped in 4.3.1 (2025-12-31); on the brief's draft-07 subset it validates with defaults applied, reports issues by path, and throws on `$ref`, `if/then/else`, `dependentRequired`; `zod/mini` exposes `toJSONSchema` but not `fromJSONSchema` (zod 4.5.4). | https://zod.dev/json-schema |
| @autoform/react | Registry | 5.0.0 (2026-07-08) is the only release in 12 months; peers `react-hook-form ^7` or `@tanstack/react-form ^1` (optional) and Zod/Yup/Joi providers (`@autoform/zod` peer `zod ^3.25 ‖ ^4`) — consumes Zod, not JSON Schema; the GitHub repo publishes no releases. | https://registry.npmjs.org/@autoform/react/latest |
| svelte-jsoneditor issue #572 | Issue | "vanilla-jsoneditor: inline style violates CSP directive" is open (26 open issues total, incl. #552 tree-mode performance with many keys and #584 axe a11y); the package bundles FontAwesome, lodash-es, CodeMirror, Ajv and the Svelte 5 runtime (320 kB gz measured). | https://github.com/josdejong/svelte-jsoneditor/issues/572 |
| codemirror.net | Docs | CodeMirror "is being developed on code.haverbeke.berlin" with bugs reported there; the GitHub mirrors (`codemirror/view`, `codemirror/lang-json`) were archived 2026-04-15 while npm publishing continues (`@codemirror/view` 6.43.10 on 2026-08-31, 41 releases in 12 months); MIT. | https://codemirror.net/ |
| uFuzzy README benchmark + registry | Benchmark | 86 searches over 162 000 phrases: uFuzzy 434 ms / 7.4 MB retained, Fuse.js 33,875 ms / 13.9 MB, FlexSearch 83 ms / 316 MB retained; "~7.5KB min"; latest 1.0.19 published 2025-08-22 with 0 releases since and 14 open issues including "Slow match and crash for single-error strings". | https://github.com/leeoniya/uFuzzy |
| Fuzzy-search benchmark at 100 000 strings | Measured (ours) | Per query / retained heap: own subsequence scorer 21.5 ms / +0.1 MiB; ufuzzy 5.6–12.9 ms / 0 but 0 hits for `clddrv` in every configuration; fzf 60.8 ms / +44.9 MiB; microfuzz 31.8 ms / +57.0 MiB; minisearch 10.7 ms / +86.8 MiB (499 ms build); flexsearch 0.9 ms / +62.6 MiB (868 ms build, prefix-only); fuse.js 490 ms (463 ms with `ignoreLocation`). | https://nodejs.org/dist/v24.18.0/ |
| Electron 41.6.1 V8 probe | Measured (ours) | `ELECTRON_RUN_AS_NODE=1 electron -p process.versions` → Chromium 146.0.7680.216, V8 14.6.202.34, ICU 77.1; `typeof globalThis.Temporal === "object"`, `Intl.DurationFormat` present (`"1:02:03"`, `"4m 12s"`), `Intl.RelativeTimeFormat` present, 418 supported time zones; plain Node 24.18 (V8 13.6) has no `Temporal`. caniuse corroborates Temporal unflagged from Chrome 144 and `Intl.DurationFormat` from Chrome 129. | https://www.npmjs.com/package/electron/v/41.6.1 |
| Axis E npm registry rows | Registry | date-fns 4.4.0 (2026-05-29), 100.05 M weekly, 663 open issues; `@js-temporal/polyfill` 0.5.1 published 2025-03-31 with 0 releases in 12 months; temporal-polyfill 1.0.4 (2026-08-13); dayjs 1.11.23 with `sideEffects: true`, CJS main and no ESM `module` field per bundlephobia, 1,315 open issues+PRs — none adds capability over native `Intl`/`Temporal` in the renderer. | https://registry.npmjs.org/date-fns/latest |

**D.9 Electron runtime, native browser view, browser tools, packaging, tests**

| Source | Type | Key Finding | URL |
| --- | --- | --- | --- |
| Electron 44 release post | Changelog | "Electron 41.x.y has reached end-of-support as per the project's support policy"; 44.0.0 released 2026-08-25 with Chromium 152.0.7977.54 / Node 24.18.1; supported majors are 44/43/42 | https://www.electronjs.org/blog/electron-44-0 |
| releases.electronjs.org + endoflife.date | Registry | 41.6.1 (repo lockfile) published 2026-05-13 on Chromium 146.0.7680.216; last 41.x is 41.10.7 (2026-08-24); 44.1.1 is 2026-09-01; endoflife.date: 41 EOL 2026-08-25, 42 EOL 2026-10-20, 43 EOL 2027-01-05, 44 EOL 2027-03-02 | https://releases.electronjs.org/releases.json |
| electron/electron PR #53031 (+ #53151/#53152/#53153) | PR | Detached-`WebContentsView` bounds fix (closes #43257) merged to main 2026-08-22 and backported to 42-x-y / 43-x-y / 44-x-y only — no 41 backport | https://github.com/electron/electron/pull/53031 |
| electron/electron #43293 + #49039 | Issue | Both open: an empty `WebContentsView` can never appear on top of a non-empty one (#43293), and there is no click-through (`setIgnoreMouseEvents`) for a view (#49039) — together they block the transparent-overlay-view design | https://github.com/electron/electron/issues/43293 |
| Electron `webContents.debugger` docs | Docs | `sendCommand(method, params, sessionId)` scoped to one webContents; `'detach'` fires "either when webContents is closed or devtools is invoked" | https://www.electronjs.org/docs/latest/api/debugger |
| electron-updater docs | Docs | "Squirrel.Windows is not supported" (NSIS only); "macOS application must be signed in order for auto updating to work"; Linux AppImage/DEB/RPM supported; staged rollouts via `stagingPercentage` | https://www.electron.build/docs/features/auto-update |
| electron-updater / electron-builder | Registry | electron-updater 6.8.9 (2026-06-05, 2.58M weekly) and electron-builder 26.15.3 (2026-06-09, 3.91M weekly), both MIT; `app-builder-bin` 4.2.0 is 198 MB unpacked (dev-only) | https://registry.npmjs.org/electron-updater/latest |
| electron-builder dist-tags | Registry | `latest` → 26.15.3; `v26` → 26.15.7 (published 2026-07-18); `next` → 27.0.0-alpha.7 — the 26.15.x line is the pin, taken from `v26` when its changelog is reviewed | https://registry.npmjs.org/electron-builder |
| update-electron-app README | Docs | Requires macOS or Windows only, code-signed macOS builds, a public GitHub repo + Releases (or S3), and Squirrel.Windows startup handling | https://github.com/electron/update-electron-app |
| electron-vite distribution guide | Docs | "Electron Forge's default output directory is `out` and forbids to override, which conflicts with electron-vite"; electron-builder presented as the complete solution | https://electron-vite.org/guide/distribution |
| electron-log file transport docs | Docs | `maxSize` default 1 MB with single `.old.log` rotation; `sync: true` by default (synchronous writes on the main process); 1 release in 12 months (5.4.4, 2026-05-14) | https://github.com/megahertz/electron-log/blob/master/docs/transports/file.md |
| Electron safeStorage docs | Docs | Windows DPAPI "protects against other users but not other apps in the same userspace"; Linux falls back to `basic_text`; available only after `ready` | https://www.electronjs.org/docs/latest/api/safe-storage |
| electron-store | Registry | 11.0.2 (2025-10-05), ESM-only, Node ≥20, depends on `conf ^15.0.2` → `ajv ^8.17` + `ajv-formats` (JSON Schema, a second schema language beside Zod v4); README: migrations "known bugs", no support | https://registry.npmjs.org/electron-store/latest |
| Electron fuses tutorial + electronegativity README | Docs | Nine fuses documented, flipped with `@electron/fuses` `flipFuses` before signing (`cookieEncryption` needs a signed macOS app); electronegativity is "no longer actively maintained" (successor is the commercial ElectroNG), last npm release 1.10.3 on 2023-03-09, and its 42 checks predate `WebContentsView` | https://www.electronjs.org/docs/latest/tutorial/fuses |
| @modelcontextprotocol/server | Registry | 2.0.0 published 2026-07-28, MIT, 5.03M weekly, deps `zod ^4.2.0` + `@modelcontextprotocol/core`; `./stdio` export; `@modelcontextprotocol/node` peer-depends on `hono ^4.11.4` | https://registry.npmjs.org/@modelcontextprotocol%2Fserver/latest |
| MCP TypeScript SDK v2 upgrade guide | Docs | "Zod v3 is no longer supported"; `inputSchema` must be `z.object(...)`; "`SSEServerTransport` is removed"; "Node.js 20+. v2 is ESM-first but ships a CommonJS build too" | https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md |
| modelcontextprotocol/typescript-sdk #2677 | Issue | Open: `tools/list` emits draft-07 `$schema` for Zod v4 schemas (with #2464 `z.date()` breaking `tools/list` and #1562 `$ref` in inputSchema) — keep tool schemas flat | https://github.com/modelcontextprotocol/typescript-sdk/issues/2677 |
| @playwright/mcp | Registry | 0.0.80 (2026-09-01) depends on `playwright 1.63.0-alpha-2026-08-31` (alpha pin) → `playwright-core` 13.4 MB unpacked; 336 prerelease publishes in 12 months | https://registry.npmjs.org/@playwright%2Fmcp/latest |
| microsoft/playwright-mcp PR #1291 | PR | "feat: add Electron application support" closed unmerged 2025-12-30 — maintainer: "I don't think we can commit to maintaining it, you can release your own server for Electron" (issue #994 closed 2025-09-08) | https://github.com/microsoft/playwright-mcp/pull/1291 |
| playwright-core `electron.ts` | Source file | Playwright launches Electron with `['--inspect=0', '--remote-debugging-port=0', ...]` and connects over WebSocket — a whole-app, unauthenticated CDP endpoint | https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/electron/electron.ts |
| chrome-remote-interface README + devtools-protocol | Registry | chrome-remote-interface needs a `--remote-debugging-port` WebSocket endpoint and its types are "automatically generated from … `devtools-protocol@0.0.927104`" (AVOID); `devtools-protocol` 0.0.1687809 (2026-08-28, BSD-3-Clause, 27.5M weekly) is types-only with `types/protocol-mapping.d.ts` and zero runtime (ADOPT) | https://registry.npmjs.org/devtools-protocol/latest |
| Vitest 4.0 announcement | Changelog | 2025-10-22: "With this release we are removing the `experimental` tag from Browser Mode"; providers split into `@vitest/browser-playwright` etc.; `toMatchScreenshot` added | https://vitest.dev/blog/vitest-4 |
| @vitest/browser-playwright / jsdom | Registry | `@vitest/browser-playwright` 4.1.11 peers on `vitest` **exactly** 4.1.11 (catalog is 4.1.5); `jsdom` 30.0.1 engines `^22.22.2 \|\| ^24.15.0 \|\| >=26` (above the Node 22.12 CI leg) and peer `canvas ^3.2.3` | https://registry.npmjs.org/@vitest%2Fbrowser-playwright/latest |
| Playwright Electron docs + PR #39912 | Docs | `_electron` is "experimental"; "Ensure that `nodeCliInspect` fuse is **not** set to `false`"; PR #39912 (merged 2026-03-27) adds a test showing `electronApp.windows()` discovers `WebContentsView`s in a `BaseWindow` | https://playwright.dev/docs/api/class-electron |
| Playwright `toHaveScreenshot` docs | Docs | pixelmatch comparator, `{name}-{browser}-{platform}.png` naming, "run tests in the same environment where the baseline screenshots were generated" | https://playwright.dev/docs/test-snapshots |
| lost-pixel / Argos / Chromatic | Measured (ours) | lost-pixel repo is archived (last release 2024-11-14); Argos Hobby is 5,000 screenshots/mo and OSS sponsorship requires a README banner + dofollow UTM link; Chromatic free tier 5,000 snapshots/mo, Storybook-centric | https://github.com/lost-pixel/lost-pixel |
| axe-core / @axe-core/playwright | Registry | 4.13.0 (2026-08-05) declares license **MPL-2.0** (not MIT/Apache-2.0/BSD/ISC) — flagged per the brief; 590 kB min / 160 kB gzip, zero deps | https://registry.npmjs.org/axe-core/latest |
| @testing-library/react | Registry | 16.3.3 (2026-08-27), MIT, peers `react ^18.0.0 \|\| ^19.0.0` and `@testing-library/dom ^10` — already in the repo at 16.3.0 | https://registry.npmjs.org/@testing-library%2Freact/latest |
| knip / size-limit | Registry | knip 6.34.0 ISC, engines `^20.19.0 \|\| >=22.12.0` (fits); size-limit 13.0.3 MIT, engines `^22.18.0 \|\| ^24.0.0 \|\| >=26.0.0` (above the Node 22.12 CI leg — run on the Node-24 leg) | https://registry.npmjs.org/size-limit/latest |
| react-scan / why-did-you-render | Docs | react-scan 0.5.7 (2026-05-27) is dev-only (`dangerouslyForceRunInProduction` "not recommended"), 104 kB gzip; why-did-you-render 10.0.1 (2025-01-20, 0 releases/12mo) "was not tested with React Compiler at all. I believe it's completely incompatible with it" | https://github.com/welldone-software/why-did-you-render |
| facebook/memlab #51 | Issue | "MemLab's CLI only supports E2E automation for web pages"; `memlab find-leaks --baseline --target --final` works on manually captured Electron `.heapsnapshot` files | https://github.com/facebook/memlab/issues/51 |

**D.10 Motion, fonts, icons, meters, formatting**

| Source | Type | Key Finding | URL |
| --- | --- | --- | --- |
| Electron 44.0 release notes and releases feed | Release notes | Electron 44.0.0 ships Chromium 152.0.7977.54 and Node 24.18.1 (44.1.1: Node 24.19.0) — the ceiling for every platform-feature verdict above since the 2026-09-01 floor move to 44.x | https://www.electronjs.org/blog/electron-44-0 |
| Electron v41.6.1 DEPS (provenance) | Source file | Electron 41.6.1 pins `chromium_version` 146.0.7680.216 and Node 24.15.0 — the binary the probe below was run on, not the target | https://raw.githubusercontent.com/electron/electron/v41.6.1/DEPS |
| Electron 41 renderer probe (measured on the then-shipped 41.6.1 binary) | Measured (ours) | `startViewTransition` ✅, `match-element` ✅, `linear()` ✅, `interpolate-size` ✅, `Intl.DurationFormat` ✅, `Temporal` ✅, `Element.startViewTransition`/`transitionRoot` ❌ — the ❌ is a property of the probe binary: `transitionRoot` and element-scoped view transitions ship at Chromium 147 (the MDN and Chrome rows below), so both are available at the 152 target; the probe is re-run on the 44.x binary by Plan-023 T-023p-1B-4 and its cells re-graded there | https://releases.electronjs.org/releases.json |
| MDN browser-compat-data | Spec | First Chromium versions: view transitions 111, `types` 125, `match-element` 137, `transitionRoot` 147, `linear()` 113, `@starting-style` 117, `interpolate-size` 129, `DurationFormat` 129, `Temporal` 144 | https://github.com/mdn/browser-compat-data |
| Chrome for Developers — element-scoped view transitions | Docs | Element-scoped/concurrent view transitions require "Chrome 147 or later"; document-scoped transitions freeze whole-document rendering during the update callback and run one at a time | https://developer.chrome.com/docs/css-ui/view-transitions/element-scoped-view-transitions |
| Chrome for Developers — view-transition misconceptions | Docs | "the data for the snapshots is taken directly from the compositor, so there are no extra layout or repaint steps" | https://developer.chrome.com/blog/view-transitions-misconceptions |
| esbuild bundle measurement (motion) | Measured (ours) | `motion/react` `{ motion, AnimatePresence, LayoutGroup }` = 41.9 kB gz; `motion/mini` animate = 3.1 kB; standalone `spring` = 1.7 kB gz | https://registry.npmjs.org/motion/latest |
| motion CHANGELOG | Changelog | 13.0.0 (2026-08-05) removed the optional `@emotion/is-prop-valid` dependency; 13.1.1 (2026-08-18) "Improved React 19 strict mode compatibility for AnimatePresence" | https://raw.githubusercontent.com/motiondivision/motion/main/CHANGELOG.md |
| motion-dom `NativeAnimationExtended.mjs` | Source file | Spring easings are "replaced … with a JS easing function. This will later get compiled to a `linear()` easing function" (10 ms sampling), gated by a `supportsLinearEasing` test | https://github.com/motiondivision/motion/tree/main/packages/motion-dom/src/animation |
| motion — React layout animations docs | Docs | "Layout animations are triggered when a component re-renders and its layout has changed"; scroll containers need `layoutScroll`; `LayoutGroup` exists because a sibling "won't be able to detect changes to its layout" | https://motion.dev/docs/react-layout-animations |
| motion issue #3801 | Issue | `@types/react` is not declared as a peer dependency, breaking types under strict linkers (pnpm) | https://github.com/motiondivision/motion/issues/3801 |
| TanStack/virtual discussion #482 | Issue | Framer Motion exit animations conflict with the virtualizer's absolute positioning; workaround is to avoid absolute positioning | https://github.com/TanStack/virtual/discussions/482 |
| `@react-spring/*` shipped dist | Source file | Animation runs on the library's own `requestAnimationFrame` loop (`rafz`, `shared`); zero `.animate(` WAAPI call sites in the dist | https://registry.npmjs.org/@react-spring/web/latest |
| `@formkit/auto-animate` `index.mjs` 0.10.0 | Source file | MutationObserver + ResizeObserver + per-child IntersectionObserver + `getBoundingClientRect` on every mutation, plus a per-element 2000 ms `setInterval` "cold-poll" | https://registry.npmjs.org/@formkit/auto-animate/latest |
| esbuild bundle measurement (icons) | Measured (ours) | Per-icon cost from 1→10 icons: lucide ~70 B, tabler ~80 B, iconoir ~190 B, radix ~250 B, phosphor ~650 B (six weights per icon); `lucide-react` full barrel 173.9 kB gz; dev installs lucide 40 MB / tabler 91 MB / phosphor 57 MB | https://registry.npmjs.org/lucide-react/latest |
| Vite 8 announcement + performance guide | Docs | Vite 8 (2026-03-12) ships rolldown but "Full Bundle Mode (experimental)" is off by default; Vite's guidance: "you should avoid barrel files and import the individual APIs directly" | https://vite.dev/blog/announcing-vite8 |
| lucide issue #4435 | Issue | Open (2026-06-04): root/barrel imports "still cause poor Vite dev performance and unnecessary build-time work" | https://github.com/lucide-icons/lucide/issues/4435 |
| shadcn/ui `components.json` docs | Docs | Documented default is `"iconLibrary": "lucide"` — the recognisable shadcn/AI-dashboard glyph set (Lucide is "a fork of Feather Icons" per its README) | https://github.com/shadcn-ui/ui/blob/main/apps/v4/content/docs/(root)/cli.mdx |
| unplugin-icons README | Docs | Compile-time icons — "Only bundle the icons you really use"; `customCollections` + `FileSystemIconLoader` for our own SVGs; React via `compiler: 'jsx', jsx: 'react'` | https://raw.githubusercontent.com/unplugin/unplugin-icons/main/README.md |
| npm registry (`@phosphor-icons/react`, `@radix-ui/react-icons`) | Registry | 0 stable releases in the last 12 months for both (2.1.10 on 2025-05-22; 1.3.2 on 2024-11-14); 90-day issue trend 1 opened / 0 closed each | https://registry.npmjs.org/@phosphor-icons/react/latest |
| fontTools table inspection | Measured (ours) | IBM Plex Sans/Mono variable woff2 carry `fpgm`+`prep`+`cvt` hinting and the `zero` feature; Inter, Geist, JetBrains Mono, Source Sans 3, Source Code Pro, Recursive variable builds carry no `fpgm`/`cvt`; fontsource subsets strip `zero`/`ss`/`cv` and the Plex `wdth` axis | https://registry.npmjs.org/@ibm/plex-sans-variable/latest |
| IBM Plex npm variable packages | Registry | `@ibm/plex-sans-variable` 0.2.0 and `@ibm/plex-mono-variable` 1.0.0 published 2026-07-30 (OFL-1.1); Roman-Latin1 splits 67 kB and 31 kB | https://registry.npmjs.org/@ibm/plex-mono-variable/latest |
| Vercel Geist font page | Docs | Geist is Vercel's "typeface specifically designed for developers and designers", OFL — the Vercel/v0 identity we want to avoid; no `zero` feature in either family (table inspection) | https://vercel.com/font |
| U.S. Graphics — Berkeley Mono | Docs | "Commercial licenses are not compatible with open-source apps"; "Commercial use restricted to UI elements only"; Developer $75 (no commercial use), Indie $225 | https://usgraphics.com/products/berkeley-mono |
| esbuild bundle measurement (charts) | Measured (ours) | `d3-shape` `{ arc, line, area, curveMonotoneX }` 3.6 kB gz; `d3-scale` `scaleLinear` 7.7 kB; `uplot` 22.5 kB + 1.8 kB CSS; visx shape+scale 16.8 kB; recharts 97.4 kB; `@nivo/line` 98.8 kB | https://registry.npmjs.org/d3-shape/latest |
| Electron Intl/Temporal probe | Measured (ours) | Renderer: `Intl.DurationFormat` digital `0:01:05.2`, unit `12.3 MB`, `340 kB/s`, compact `12.3K`, relative `yesterday`; `Temporal.Duration.round` → `DurationFormat` works; toolchain Node 24.18 (V8 13.6) has no `Temporal`; formatter construction 0.009–0.031 ms vs 0.002 ms per cached `format()` | https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DurationFormat/DurationFormat |
| `pretty-ms` 9.3.1 registry + README | Registry | 9.3.1 published 2026-08-28, MIT, ESM, 1.1 kB gzip plus `parse-ms`; every case the console needs (compact durations, sub-second, "parked · resumes 04:12") is covered by native `Intl.DurationFormat` in Chromium 146 plus a fifteen-line unit picker, so the dependency is avoided. | https://registry.npmjs.org/pretty-ms/latest |
| `filesize` 11.0.22 registry + README | Registry | 11.0.22 published 2026-07-09, BSD-3-Clause, ESM, 2.0 kB gzip; byte figures are formatted by native `Intl.NumberFormat` unit style with a ten-line unit picker, so the dependency is an own build. | https://registry.npmjs.org/filesize/latest |

### Related Specs

- [Spec-007: Local IPC And Daemon Control](./007-local-ipc-and-daemon-control.md) — the typed daemon contract the renderer reuses via the shared client SDK
- [Spec-008: Control Plane Relay And Session Join](./008-control-plane-relay-and-session-join.md) — control-plane authentication and relay transport
- [Spec-012: Approvals, Permissions, Trust Boundaries](./012-approvals-permissions-and-trust-boundaries.md) — Approvals view composition target
- [Spec-013: Live Timeline Visibility And Reasoning Surfaces](./013-live-timeline-visibility-and-reasoning-surfaces.md) — Timeline view composition target
- [Spec-015: Persistence Recovery And Replay](./015-persistence-recovery-and-replay.md) — replay-from-here behavior in the Timeline view
- [Spec-016: Multi-Agent Channels And Orchestration](./016-multi-agent-channels-and-orchestration.md) — Multi-Agent Channels view composition target (V1-readiness review in BL-042)
- [Spec-002: Invite, Membership, Presence](./002-invite-membership-and-presence.md) — Invites view composition target
- [Spec-004: Queue, Steer, Pause, Resume](./004-queue-steer-pause-resume.md) — Runs view composition target
- [Spec-026: First-Run Onboarding](./026-first-run-onboarding.md) — first-run relay choice surfaced by the shell (to be authored per BL-081)
- [Spec-029: Provider Accounts And Credential Homes](./029-provider-accounts-and-credential-homes.md) — Provider Accounts And Cost view composition target
- [Spec-019: Notifications And Attention Model](./019-notifications-and-attention-model.md) — the attention projection the console's notification center composes; owner of the global-only mute
- [Spec-009: Repo Attachment And Workspace Binding](./009-repo-attachment-and-workspace-binding.md) — `§Detach Semantics (V1 Definition)` forbids a renderer detach surface; the console discloses the CLI path instead
- [Spec-003: Runtime Node Attach](./003-runtime-node-attach.md) — the shared-terminal write lease the `terminal` pane kind is gated on
- [Spec-017: Workflow Authoring And Execution](./017-workflow-authoring-and-execution.md) — the `workflow-run` and `workflow-builder` pane kinds compose its surfaces

### Related ADRs

- [ADR-016: Electron Desktop Shell](../decisions/016-electron-desktop-shell.md) — forward declaration this spec implements
- [ADR-010: PASETO + WebAuthn + MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md) — WebAuthn PRF credential path
- [ADR-009: JSON-RPC IPC Wire Format](../decisions/009-json-rpc-ipc-wire-format.md) — daemon IPC wire format the preload bridge forwards
- [ADR-014: tRPC Control Plane API](../decisions/014-trpc-control-plane-api.md) — control-plane transport the preload bridge forwards
- [ADR-026: Visual Node-Graph Workflow Authoring](../decisions/026-visual-node-graph-workflow-authoring.md) — the `@xyflow/react` decision the `workflow-builder` pane kind holds to
- [ADR-020: V1 Deployment Model And OSS License](../decisions/020-v1-deployment-model-and-oss-license.md) — §Decision Log records the test-only MPL-2.0 `axe-core` admission
- [ADR-028: Provider Credential Custody Posture](../decisions/028-provider-credential-custody-posture.md) — the write-only-credential rule every console input obeys

### Related Architecture Docs

- [Container Architecture](../architecture/container-architecture.md) — renderer-untrusted trust boundary; canonical monorepo topology
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md) — shell / renderer / client-SDK component decomposition
- [Security Architecture](../architecture/security-architecture.md) — auth material handling; §Local Daemon Authentication reconciled with this spec under BL-056 on 2026-04-18
- [Deployment Topology](../architecture/deployment-topology.md) — desktop-shell placement in the per-participant local container set

### Related Backlog Items

- [BL-041](../archive/backlog-archive.md) — this spec (authoring)
- [BL-043](../archive/backlog-archive.md) — Plan-023 implementation plan (implements this spec)
- [BL-056](../archive/backlog-archive.md) — resolved 2026-04-18; `security-architecture.md` §Local Daemon Authentication now reflects the renderer-untrusted stance this spec declares
- [BL-078](../archive/backlog-archive.md) — Plan-024 Rust PTY sidecar (supervised by the daemon, not the shell; referenced for completeness)
- [BL-081](../archive/backlog-archive.md) — Spec-026 first-run onboarding (the shell surfaces the three-way-choice UX)
