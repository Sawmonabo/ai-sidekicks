# Plan-016: Notifications And Attention Model

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `016` |
| **Slug** | `notifications-and-attention-model` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-017: Notifications And Attention Model](../specs/017-notifications-and-attention-model.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-013](../decisions/013-trpc-control-plane-api.md) (`push.send` is a control-plane call), [ADR-014](../decisions/014-v1-feature-scope-definition.md), [ADR-016](../decisions/016-shared-event-sourcing-scope.md) (the attention projection is daemon-local and no session event leaves the daemon for a notification), [ADR-017](../decisions/017-cross-version-compatibility.md) (D-016-4's additive optional `runId`), [ADR-036](../decisions/036-workflow-secrets-in-the-os-keychain.md) (the web address, its signing secret and the mail password are sealed in the same keychain store) |
| **Dependencies** | [Plan-010](./010-transcript-and-reasoning.md) (transcript visibility), [Plan-001](./001-session-core.md) (the session lifecycle that serves `session.mute` and `session.unmute` and keeps `muted_at`), [Plan-020](./020-desktop-app-and-renderer.md) (the main process, the machine's settings file and its `machineSettings` members, the navigation member a notification click rides, the single-instance handoff the windowless start uses), [Plan-014](./014-workflow-authoring-and-execution.md) (the Notify node that writes its entry), [Plan-025](./025-remote-control.md) (the device push key, the presence heartbeat's `appVisible`, and the `push.send` senders), [Plan-004](./004-session-event-taxonomy-and-audit-log.md) (the constructor-injected `DaemonCredentialProvider` credential seam, CP-004-6, that the daemon's `push.send` call authenticates through) |
| **Cross-Plan Deps** | Cross-Plan Dependency Graph |

## Goal

Implement the derived attention projection, the operating-system notification on every device, and delivery beyond the machine (a sealed push per device, a web address and an email digest), so actionable session state stays visible when the user is not watching the transcript.

## Scope

This plan covers the attention projection and its kinds, the one gate the daemon applies when it writes an entry (the notification switches and a session's mute), the per-session mute, the main process's notifications and the windowless start that posts one while the app is closed, the per-device push decision and seal, the web address and the email digest, the Notifications settings page and its settings-file keys, and degraded paths when notifications are unavailable.

## Non-Goals

- The push senders, the device push key's registration, the phone apps and the web client's service worker ([Plan-025](./025-remote-control.md)); this plan decides and seals each push and calls `push.send`
- Marketing or email campaigns; the digest goes only to the person's own address
- A full on-call paging system for the person

## Preconditions

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/attention.ts` (the entry shape, the live projection read, `attention.bannerSettle`, `attention.seenUpdate`, the delivery verbs and their refusals, and the plaintext push notice a device opens)
- `packages/contracts/src/push.ts` (`push.send`'s request: the sealed notice, the device's push address, the collapse id, the priority and the expiry)
- `packages/runtime-daemon/src/attention/` (the projector, the gate at entry write, the windowless start, the per-device push decision and seal)
- `packages/runtime-daemon/src/attention/delivery/` (new in T3.3: the web-address sender, the digest scheduler and sender, the outcome table, the delivery verbs' handlers)
- `packages/runtime-daemon/src/ipc/handlers/` (the `attention.*` handlers)
- `packages/client-sdk/src/attention.ts` (new in T3.2: every attention verb the main process and the renderer call)
- The desktop main process's notifications service: the poster, the withdrawal, the app-icon count and banner mode
- The desktop renderer: the Notifications list in `layout/NotificationsList/`, opened from the rail's bell, with its projection, count and notifier in `store/attention/`; the Notifications settings page in `features/settings/` (T3.7), which on the machine reads and writes the machine's settings file and on a phone app or the web client keeps its switches and kinds on the device and hands them to each machine through `device.notificationSettingsSet`; the muted row mark in `features/sessions/` and the inspector's `Notifications` fact in `features/inspector/`

## Data And Storage Changes

- No control-plane table. The attention projection is rebuilt from canonical events in the daemon and keyed to canonical session or run state; each entry keeps its delivery facts in the daemon's local store: `bannerState` (`pending | posted | withheld | withdrawn`), `digested_at` once a digest has carried it, and `web_address_state` (`pending | delivered | undelivered`) with an attempt count. See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md).
- `muted_at` on the sessions row, rebuilt from the `session.muted` and `session.unmuted` events and gone with the session.
- One delivery outcome row per outside channel (the web address, the email digest), overwritten on every attempt and removed with the channel's secret.
- The notification preferences are the machine's settings file's `notifications` keys (the switches; the four kinds `notifications.kinds.waitingOnYou`, `.finished`, `.failed` and `.notifyStep`, booleans that read `true` when missing; the web address's switch and `Send` kinds, `notifications.webAddress {enabled, kinds}`; the digest's settings other than its password, `notifications.emailDigest {enabled, sendTo, mailServer?, port?, userName?, after}`), which [Plan-020](./020-desktop-app-and-renderer.md) owns as a file and the daemon writes as its one writer. No secret is in the file. On a phone app or the web client the Notifications page's two switches and four kinds are that device's own, kept on the device and handed to each machine by [Plan-025](./025-remote-control.md)'s `device.notificationSettingsSet` on every connection and every change; the machine only keeps the copy.
- The web address, its signing secret and the mail password are sealed in the operating system's keychain through the workflow-secret store module ([ADR-036](../decisions/036-workflow-secrets-in-the-os-keychain.md)).
- Maintain both run-scoped attention projections and session-scoped aggregate attention projections so client surfaces do not reconstruct aggregate state ad hoc.

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-016 PRs and downstream extensions. Each grounds a property the §Test And Verification Plan bullets below verify, and each carries the id a task's `Verifies invariant:` field names.

- **I-016-1 — Attention state is derived from canonical session and run state, never from client heuristics.** Every attention item and every emitted notification traces to a canonical event or canonical run/session state; a transient client observation never mints attention, and a client that has observed nothing derives the same state on a rebuild as one that watched the whole session. **Grounds in:** [Spec-017 §Required Behavior](../specs/017-notifications-and-attention-model.md#required-behavior) ("Notification emission must be derived from canonical session or run state, not from client heuristics alone"), [Spec-017 §State And Data Implications](../specs/017-notifications-and-attention-model.md#state-and-data-implications) ("Attention state is a derived projection from canonical events"), [Spec-017 §Pitfalls To Avoid](../specs/017-notifications-and-attention-model.md#pitfalls-to-avoid) ("Basing notifications only on transient client events"). **Why load-bearing:** it is what makes attention reproducible across devices and reconnects — the property every device's notification, the push and the desktop surfaces all assume.
- **I-016-2 — Notification-delivery failure never removes in-app attention state.** An operating-system notification the platform denies or suppresses, a push that is never delivered, a web-address message that ends undelivered and a digest the mail server refuses are all delivery-layer outcomes; none of them clears, resolves, or hides the underlying attention item, which resolves only when the state that produced it resolves. **Grounds in:** [Spec-017 §Fallback Behavior](../specs/017-notifications-and-attention-model.md#fallback-behavior) ("If notification delivery is delayed, the session attention projection must still reflect outstanding actionable items"; "If OS notifications are unavailable or denied, the system must still show in-app badges and attention summaries"), [Spec-017 §Acceptance Criteria](../specs/017-notifications-and-attention-model.md#acceptance-criteria) AC-2 ("Notification loss does not remove in-app attention state"). **Why load-bearing:** it is the reason every channel may be best effort — losing a delivery costs a missed notification, never attention state.
- **I-016-3 — A kind switch, the master switch and a session's mute withhold notifications and deliveries off the machine only; none of them removes, hides or downgrades an entry in the bell's list or the count, and a mute never withholds `Waiting on you`.** **Grounds in:** [Spec-017 §Fallback Behavior](../specs/017-notifications-and-attention-model.md#fallback-behavior) (the switches and the mute withhold deliveries only), [Spec-017 §Required Behavior](../specs/017-notifications-and-attention-model.md#required-behavior) (a muted session's `Waiting on you` is untouched), [Spec-017 §Pitfalls To Avoid](../specs/017-notifications-and-attention-model.md#pitfalls-to-avoid) ("Letting muted informational noise hide blocking approval state"). **Why load-bearing:** the gate runs once, when the daemon writes an entry, so a gate defect is silent — nothing downstream re-decides an entry written `withheld`.
- **I-016-4 — Session-scoped aggregate attention stays actionable until every contributing actionable item resolves, and clients read it from the canonical projection rather than recomputing it.** The aggregate is `actionable` while any unresolved run-scoped contributor is actionable, and it is served by `AttentionProjectionRead` — no client surface derives its own aggregate from a partial local view. **Grounds in (per leg):** the aggregate-resolution leg grounds in [Spec-017 §Default Behavior](../specs/017-notifications-and-attention-model.md#default-behavior) ("session-scoped attention defaults to an aggregate of unresolved run signals") and [Spec-017 §Example Flows](../specs/017-notifications-and-attention-model.md#example-flows) (the two-concurrent-runs flow, whose session aggregate "stays actionable until both are resolved"). The single-source leg and the deterministic representative-contributor selection chain in D-016-2 are **plan-owned**: no Spec-017 clause forbids client-side reconstruction or fixes a tiebreak order — [Spec-017 §Implementation Notes](../specs/017-notifications-and-attention-model.md#implementation-notes) asks only that the projection be queryable without rebuilding from the full transcript — so the canonical-projection prohibition and the total tiebreak are enforcement this plan designs on top of the spec's stated behavior. **Why load-bearing:** ad-hoc client aggregation is how a session badge and its run badges drift apart, and a non-total tiebreak lets two readers of one projection state disagree about which contributor an aggregate names.
- **I-016-5 — What leaves the machine names a subject and its state and nothing more, and no delivery secret is ever shown back.** A notification, a push, a web-address message and a digest line carry a session's or run's name, its state and its address, never a sentence from a transcript. The mail password, the web address beyond its scheme and host, and the signing secret after the one reply that creates it appear in no reply, event, log line or error. **Grounds in:** [Spec-017 §Interfaces And Contracts](../specs/017-notifications-and-attention-model.md#interfaces-and-contracts) (no secret on any reply, event, log or error), [Spec-017 §Cross-Device Delivery](../specs/017-notifications-and-attention-model.md#cross-device-delivery) (never a sentence from a transcript). **Why load-bearing:** a leaked address is a leaked token for the chat service it names, and a notification body reaches places the person does not control.

## Cross-Plan Obligations

Plan-016 keeps no control-plane table, so it owes no Path-2 account-deletion reciprocal to [Plan-019](./019-data-retention-export-and-deletion.md): a session's entries, delivery facts and `muted_at` are the machine's and go with the session. It relies on these plans for pieces it does not build:

- [Plan-001](./001-session-core.md): the session lifecycle serves `session.mute` and `session.unmute`, appends `session.muted` and `session.unmuted`, keeps `muted_at` and carries `muted` on `session.list` and `session.read`.
- [Plan-020](./020-desktop-app-and-renderer.md): the machine's settings file and its `notifications` keys, `machineSettings.read`, `write` and `subscribe`, `native.getNotificationPermission`, the navigation member a notification click rides to the renderer, and the single-instance handoff banner mode uses.
- [Plan-014](./014-workflow-authoring-and-execution.md): the Notify node writes one entry of kind `workflow_notify`, with its step's id and a moment id from the run, the node and the execution index, and emits no event of its own.
- [Plan-025](./025-remote-control.md): each device's push key and push address, the presence heartbeat's `appVisible` (lock and sleep count as not in front), and the `push.send` senders that add only the person's own APNs, FCM or VAPID credentials.

## API And Transport Changes

- Add the attention contracts to `packages/contracts/src/attention.ts` and the typed client SDK. `attention.projectionRead` rides the daemon JSON-RPC transport only (the projection is daemon-local per [ADR-016](../decisions/016-shared-event-sourcing-scope.md), the `transcript.*` posture) and is served live: the whole projection, then every change, the way `command.list` is served, so no `attention.subscribe` exists. `attention.bannerSettle {entryId, state}` (main process only; a no-op once the entry is past `pending`) and `attention.seenUpdate {sessionId}` ride the same transport. Their wire strings are registered in the [Attention Method-Name Registry](../architecture/contracts/attention-payloads.md#attention-method-name-registry) (D-016-3).
- No preference methods. On the machine the switches and the kinds are the machine's settings file's `notifications` keys, written through `machineSettings.write(change)`, which the main process hands to the daemon, the file's one writer, as `daemon.machineSettingsUpdate {change}` (its contract beside `MachineSettings` in `packages/contracts`); the daemon reads the file when it writes an entry or sends. The SDK client `packages/client-sdk/src/attention.ts`, new in T3.2, covers every attention verb the main process and the renderer call: `attention.projectionRead`, `attention.bannerSettle`, `attention.seenUpdate` and the delivery verbs.
- Require every entry to reference the underlying canonical event or derived blocking state that caused it.
- **Delivery verbs**, in the `attention` domain, on the daemon transport: `attention.deliveryRead`, `attention.mailPasswordSave`, `attention.mailPasswordRemove`, `attention.webAddressSave`, `attention.webAddressSecretRotate`, `attention.webAddressRemove` and `attention.deliveryTest`, with the refusals `attention.delivery_store_unavailable` and `attention.delivery_not_configured`, as [Spec-017 §Interfaces And Contracts](../specs/017-notifications-and-attention-model.md#interfaces-and-contracts) gives their shapes.
- **Web address.** `Send to a web address`, off by default: one [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks)-signed JSON `POST` for each moment of the kinds picked for it, never for a muted session's `Finished` or `Failed`; whatever the person types, saved as typed with nothing refused; text with no scheme and host reads masked with no host, and each message to it fails and counts as undelivered; a 15-second timeout; retries at 5 seconds, 5 minutes and 30 minutes, at most 100 waiting; the address and its signing secret sealed in the keychain. It sends only while no app window is in front on any of the person's devices, and a workflow's Notify step always sends.
- **Push.** The daemon seals each notice to the device's push key and calls the control plane's `push.send` with it (D-016-3); nothing else about a notification crosses to the control plane. The plaintext notice a device opens after unsealing is a contract in `packages/contracts/src/attention.ts`, since the phone apps and the web client's service worker read it, and `push.send`'s request is a contract in `packages/contracts/src/push.ts`, since the daemon calls it and the control plane serves it.
- **Aggregate-carrier derivation rule (D-016-2).** [Spec-017 §Required Behavior](../specs/017-notifications-and-attention-model.md#required-behavior) requires attention at both run scope and session scope, and the shared `AttentionItem` shape in [attention-payloads.md](../architecture/contracts/attention-payloads.md) carries a single `trigger`, a single `severity`, and a single `sourceEventId` — leaving it unstated which field carries an aggregate over several unresolved contributors, and where a derived item's `sourceEventId` comes from. This plan fixes the rule; it changes no field shape:
  - **Scope discriminator, not a second type.** A session-scoped aggregate is an `AttentionItem` whose `runId` is **absent**; a run-scoped item carries `runId`. There is no separate aggregate type and no aggregate-only field.
  - **`severity` carries the aggregate.** The aggregate is `actionable` if **any** unresolved run-scoped contributor is actionable, and `informational` only when every unresolved contributor is informational — the direct reading of [Spec-017 §Default Behavior](../specs/017-notifications-and-attention-model.md#default-behavior)'s aggregate of unresolved run signals, and the property [Spec-017 §Example Flows](../specs/017-notifications-and-attention-model.md#example-flows)'s two-concurrent-runs example illustrates. It resolves (leaves the actionable set) only when the last contributing actionable item clears (I-016-4).
  - **`trigger` and `sourceEventId` come from one deterministically selected representative contributor** — highest severity first (`actionable` before `informational`), then earliest `createdAt`, then lexicographically smallest `id`. The tiebreak chain is total, so two readers of the same projection state derive the same aggregate rather than two that differ only in which contributor they happened to visit first. Selecting a real contributor rather than synthesizing a placeholder is what keeps `sourceEventId` resolvable, so the field stays non-optional for every item the projection returns.
  - **Aggregates are read-projection-only.** They are returned by `attention.projectionRead` and never raise a notification: a notification is posted for the single canonical entry that caused it, so no aggregate is ever posted and no per-contributor fan-out is inferred from one.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define the attention entry, its kinds, the live projection read, the settle and seen verbs, and the delivery verbs in shared contracts.
2. Implement the projection rebuilt from canonical events, the gate at entry write, the mute's withdrawal and the windowless start in the daemon.
3. Implement delivery beyond the machine: the web address, the email digest and the per-device push decision and seal.
4. Add the main process's notifications and the renderer's attention surfaces and Notifications page, with degraded fallback to in-app badges and summaries when OS delivery is unavailable.

## Parallelization Notes

- The delivery sender work (web address and digest) and the push decision can proceed in parallel once the entry shape and the gate are fixed.
- The main process's notifications and the renderer surfaces wait for the live projection and the settle verb.

## Test And Verification Plan

Each bullet below verifies a numbered invariant from §Invariants; the trailing id is the entry a task's `Verifies invariant:` field resolves to.

- Attention-projection tests covering approvals, required input, a waiting plan, completion, failure and a Notify step — each derived from canonical state, none from a transient client observation (**I-016-1**)
- Notification-fallback tests proving a denied OS notification, a failed push, an undelivered web-address message and a refused digest leave the in-app attention entry present and unresolved (**I-016-2**)
- Gate tests proving a muted session's `Waiting on you` entry is written `pending` and counted while its `Finished` entry is written `withheld`, a kind switched off withholds only that kind's notification and leaves the list and the count unchanged, and a withdrawal is never withheld; a mutation that lets the mute withhold `Waiting on you` fails the test (**I-016-3**)
- Projection tests proving session-scoped aggregate attention resolves only when all underlying run-scoped actionable items are cleared, and that the aggregate's representative contributor is selected deterministically under the D-016-2 tiebreak chain (**I-016-4**)
- Leak and content tests proving the mail password (including in an SMTP refusal that echoes the user name), the web address beyond its scheme and host and the signing secret after its one showing never appear in a reply, event, log line or error, and that a body built for a session whose transcript holds a sentence never contains it (**I-016-5**)

## Implementation Phase Sequence

Plan-016 implementation lands as a sequence of small PRs. Phase 1 fixes the attention contracts and the kinds every later layer keys on; Phase 2 lands the projection rebuilt from canonical events, the gate at entry write, the mute's withdrawal and the windowless start in the daemon; Phase 3 lands the delivery surfaces: the main process's notifications, the renderer's surfaces and settings page, the web address, the email digest and the per-device push. Each phase carries a `**Precondition:**` line.

### Phase 1 — Attention Contracts And Kinds

**Precondition:** Plan-001 Phase 2 merged — the shared contracts package plus the `SessionId` / `RunId` brands these payloads reference.

**Goal:** `packages/contracts/src/attention.ts` exports the attention entry, the live projection read, the settle and seen verbs, and the delivery verbs with their refusals; no service, storage, or delivery code lands.

#### Tasks

##### T1.1 — The attention entry and its kinds

- **Files:** `packages/contracts/src/attention.ts` (new), reached at its own subpath, `@ai-sidekicks/contracts/attention`, with nothing to re-export.
- **Step:** Author `AttentionItemSchema` (`.strict()`) with `id`, `momentId` (the session or run and the moment it is in, minted by the projection), `sessionId`, optional `runId`, `trigger`, `severity`, the display name and state phrase, optional `stepId` (on a Notify-step entry), `sourceEventId` (required), `bannerState` (`pending | posted | withheld | withdrawn`), `createdAt` and optional `resolvedAt`. `trigger` is a `z.enum` over `pending_approval`, `pending_input`, `run_completed`, `run_failed` and `workflow_notify`, with no `mention`; `severity` is `actionable` / `informational`. `runId` presence is the scope discriminator per D-016-2; do not add an aggregate-only field.
- **Test:** none of its own (a contract definition); the Phase 2 tests exercise it.
- **Spec coverage:** Spec-017 §Required Behavior (the kinds); Spec-017 §Interfaces And Contracts (the entry's fields)
- **Verifies invariant:** none

##### T1.2 — `attention.projectionRead`, served live

- **Files:** `packages/contracts/src/attention.ts`.
- **Step:** Author the request and the live reply: the whole projection, then every change. The request narrows by the D-016-4 rule when a caller names a session (`scope: "run"` requires `runId`, `runId` is admissible only with `scope: "run"`); with no session named, the reply is the whole projection across every session and workflow run, which the bell, its list and the app-icon count read.
- **Test:** the D-016-4 refusals at parse: `scope: "run"` without `runId`, and `runId` beside `scope: "session"` or no scope, each refused.
- **Spec coverage:** Spec-017 §Interfaces And Contracts (`attention.projectionRead` served live)
- **Verifies invariant:** I-016-4 (the shape half — the aggregate is returned by the projection; its resolution behavior is verified at T2.2)

##### T1.3 — `attention.bannerSettle`, `attention.seenUpdate` and the delivery verbs

- **Files:** `packages/contracts/src/attention.ts`.
- **Step:** Author `attention.bannerSettle {entryId, state}`, `attention.seenUpdate {sessionId}`, and the delivery verbs and refusals exactly as Spec-017 §Interfaces And Contracts gives them: `attention.deliveryRead`, `attention.mailPasswordSave`, `attention.mailPasswordRemove`, `attention.webAddressSave`, `attention.webAddressSecretRotate`, `attention.webAddressRemove`, `attention.deliveryTest`; `attention.delivery_store_unavailable`, `attention.delivery_not_configured`. The password and the address are request-only members: no reply schema carries either, and the signing secret appears only on the replies that create it.
- **Test:** none of its own; the secret-handling tests run against the services at T3.4 and T3.5.
- **Spec coverage:** Spec-017 §Interfaces And Contracts
- **Verifies invariant:** I-016-5 (the type-level half)

##### T1.4 — The mute's contract

- **Files:** the session contracts in `packages/contracts/src/session/methods.ts` and the event union in `packages/contracts/src/event/session.ts`.
- **Step:** Add `session.mute {sessionId}` and `session.unmute {sessionId}` answering `{}`, the events `session.muted {sessionId, at}` and `session.unmuted {sessionId, at}`, and `muted` on the `session.list` and `session.read` entries.
- **Test:** none of its own; the mute's behavior is verified at T2.4.
- **Spec coverage:** Spec-017 §Interfaces And Contracts (the mute verbs and events)
- **Verifies invariant:** none

### Phase 2 — The Projection, The Gate And The Mute

**Precondition:** Phase 1 merged; Plan-010 Phase 2 merged — the catch-up-aware projection substrate the attention projector reads canonical events through. The mute's withdrawal (T2.4) also waits for Plan-001's session lifecycle to serve the mute verbs.

**Goal:** the daemon derives the run-scoped and session-scoped projection from canonical events, applies the one gate when it writes an entry, serves the projection live with the settle and seen verbs, withdraws a muted session's standing notifications, and starts the app windowless to post a notification while no main process is connected. No main-process or renderer delivery lands.

#### Tasks

##### T2.1 — `attention/projector.ts`: entries from canonical events

- **Files:** `packages/runtime-daemon/src/attention/projector.ts` (new) plus co-located tests.
- **Step:** Derive entries by rebuilding from canonical session and run events: on Claude Code the held permission or question request and the turn's `result`; on Codex the thread status flags `waitingOnApproval` and `waitingOnUserInput` and `turn/completed`; a waiting plan card; a run halted after a restart on the restart question (its `waiting_for_input` state carrying `recovery-needed`), as `pending_input`; a session's or workflow run's finish and failure; and a Notify step's entry, whose moment id comes from the run, the node and the execution index. Map each to its trigger and default severity. The projector reads canonical state only and accepts no client-supplied attention input, and never reads a provider's own notification feature.
- **Test:** one case per trigger asserting the derived entry's trigger, severity and `sourceEventId`, a run halted on the restart question among the `pending_input` cases; a rebuild-equivalence case asserting that projecting the same event log twice, and projecting it from cold, yield identical entries; a case asserting an entry resolves only when the underlying state resolves.
- **Spec coverage:** Spec-017 §State And Data Implications; Spec-017 §Required Behavior
- **Verifies invariant:** I-016-1

##### T2.2 — Session-scoped aggregate projection and the D-016-2 carrier rule

- **Files:** `packages/runtime-daemon/src/attention/projector.ts` plus co-located tests.
- **Step:** Derive the session-scoped aggregate as an `AttentionItem` with `runId` absent, applying the derivation rule in §API And Transport Changes: severity is actionable while any unresolved contributor is actionable; `trigger` and `sourceEventId` come from the representative contributor selected by highest severity, then earliest `createdAt`, then lexicographically smallest `id`. Serve it from `attention.projectionRead`; expose no partial input from which a client could assemble its own.
- **Test:** the two-concurrent-runs case asserting the aggregate stays actionable until both underlying entries clear; a determinism case asserting two projections over the same contributor set in different insertion orders select the same representative, including a tie on severity and a further tie on `createdAt`.
- **Spec coverage:** Spec-017 §Default Behavior; Spec-017 §Example Flows
- **Verifies invariant:** I-016-4

##### T2.3 — The gate at entry write

- **Files:** `packages/runtime-daemon/src/attention/gate.ts` (new) plus co-located tests.
- **Step:** When the daemon writes an entry, read the machine's settings file right then (no copy, no watcher) and write `bannerState: withheld` for a kind switched off, the master switch off, or a muted session's `Finished` or `Failed`; otherwise `pending`. A missing key reads `true`. The gate never touches the entry's place in the list or the count, and no preference gates a withdrawal. Moments that resolve within half a second of the first are merged by the subject they belong to, so one subject is posted once and two subjects each get their own notification; a later moment of the same subject replaces its notification rather than stacking a second; the list keeps every entry.
- **Test:** a muted session's `Waiting on you` entry is written `pending` and counted while its `Finished` entry is written `withheld`; a kind switched off writes `withheld` and the entry is still listed and, when waiting, counted; a mutation that lets the mute withhold `Waiting on you` fails the test; two moments of one session within half a second post one notification while two sessions post two, and both sessions' entries stay listed.
- **Spec coverage:** Spec-017 §Required Behavior (one decision at entry write); Spec-017 §Fallback Behavior
- **Verifies invariant:** I-016-3

##### T2.4 — The live read, the settle and seen verbs, and the mute's withdrawal

- **Files:** `packages/runtime-daemon/src/ipc/handlers/attention/projection-read.ts`, `attention/banner-settle.ts` and `attention/seen-update.ts` (new), registered against the daemon `MethodRegistry`; the `session.muted` listener in `packages/runtime-daemon/src/attention/`; plus co-located tests.
- **Step:** Serve `attention.projectionRead` live (the whole projection, then every change). Serve `attention.bannerSettle`, callable by the main process only and a no-op once the entry is past `pending`, and `attention.seenUpdate`, which sets the one seen-or-unseen fact. On `session.muted`, withdraw the session's `Finished` and `Failed` notifications still standing, by moment id.
- **Test:** a second `attention.bannerSettle` for an entry already `posted` changes nothing, so a notification is never posted twice; after a daemon restart a muted session still reads `muted: true`, rebuilt from its events.
- **Spec coverage:** Spec-017 §Interfaces And Contracts
- **Verifies invariant:** I-016-2

##### T2.5 — The windowless start

- **Files:** `packages/runtime-daemon/src/attention/banner-launcher.ts` (new) plus co-located tests.
- **Step:** When the daemon writes a `pending` entry and no main process is connected, start the app's own program with no window and `--banner` (on macOS through LaunchServices, `open -g -b <bundleId> --args --banner`; on Windows, native or WSL, through the daemon's Windows half). A `withheld` entry starts nothing. Banner mode itself is the main process's (T3.1).
- **Test:** a `withheld` entry starts no process; a `pending` entry with a main process connected starts no process. The banner itself is accepted on signed, packaged builds on macOS, Windows and Linux.
- **Budget:** measured once in this task's PR on a signed macOS build, against the windowless start's figures: ready in 0.15 to 0.21 s, gone by 0.3 s, one process of about 113 MB, and no Dock icon.
- **Spec coverage:** Spec-017 §Desktop-to-Desktop Delivery (with the app closed)
- **Verifies invariant:** none

### Phase 3 — Notification Emission And Delivery Surfaces

**Precondition:** Phase 2 merged; Plan-020 Phase 2's machine settings members (T-020r-2-8), which T3.1 reads for the app-icon count and T3.7's Notifications page reads and writes; Plan-020 Phase 4's deep-link handler (T-020r-4-3), whose navigation member carries a notification click to T3.2's landing; the workflow-secret keychain store module ([ADR-036](../decisions/036-workflow-secrets-in-the-os-keychain.md)) landed, for T3.4 and T3.5; Plan-025's push key and senders, for T3.6. T3.5, the email digest, is built last of all, after the Release group ([cross-plan-dependencies.md §Platform order](../architecture/cross-plan-dependencies.md#platform-order)).

**Goal:** the main process posts, settles and withdraws notifications and sets the app-icon count; the renderer draws the bell's list, the muted row mark and the Notifications page; the daemon sends to the web address, sends the email digest and pushes to devices with no live connection.

#### Tasks

##### T3.1 — The main process's notifications

- **Files:** the notifications service in the main process (new) plus co-located tests.
- **Step:** Read the live projection. Post an Electron `Notification` for each `pending` entry while no app window is in front (a window behind a locked or sleeping screen is not in front), and for a Notify-step entry either way; settle each through `attention.bannerSettle`; replace in place by moment id; withdraw on resolve, with `close()` while the main process still holds that `Notification` and, on Windows otherwise, through the daemon's Windows half and the toast history. Set the app-icon count from the waiting entries, with `app.setBadgeCount` on macOS and Linux and `BaseWindow.setOverlayIcon` on Windows, reading `Show a count on the app icon`. Read no kind switch. In banner mode (`--banner`): set the accessory activation policy before any window, take the single-instance lock or exit, post through the same poster, settle, and quit; a second instance turns it into the windowed app. When OS notifications are unavailable, denied or fail, the in-app surfaces carry on and the attention state is untouched.
- **Test:** a denied OS-notification permission still leaves the in-app badge and summary; a failed post leaves the entry present and unresolved; an entry already past `pending` is never posted again.
- **Spec coverage:** Spec-017 §Desktop-to-Desktop Delivery; Spec-017 §Fallback Behavior; Spec-017 AC2
- **Verifies invariant:** I-016-2

##### T3.2 — The renderer's attention surfaces and the click

- **Files:** the Notifications list in `layout/NotificationsList/` and its projection, count and notifier in `store/attention/`; the muted row mark in `features/sessions/` and the inspector's `Notifications` fact in `features/inspector/`, and the click's landing in `routing/`; `packages/client-sdk/src/attention.ts` (new), which exposes `attention.projectionRead`, `attention.bannerSettle`, `attention.seenUpdate` and the delivery verbs, the attention verbs the main process and the renderer call.
- **Step:** Draw the bell's list (`Waiting on you` with its count, then `Earlier`; no empty group; with no entries, the heading and nothing under it), landing a line on the session's place; draw the muted row mark and the inspector fact; route a notification click from the main process's navigation member to the session's place. The client returns the server's aggregate as received and computes none of its own.
- **Test:** a muted session still shows a blocking approval-required entry in-app; a session badge stays actionable while any contributing run entry is actionable and clears only with the last one.
- **Spec coverage:** Spec-017 §The Console's Attention Surfaces; Spec-017 §Default Behavior; Spec-017 AC3
- **Verifies invariant:** I-016-3, I-016-4

##### T3.3 — Delivery outcomes and the test sends

- **Files:** `packages/runtime-daemon/src/attention/delivery/` (new: the outcome table and the `attention.deliveryRead` and `attention.deliveryTest` handlers) plus co-located tests.
- **Step:** Keep one outcome row per channel, overwritten on each attempt and removed with the channel's secret; answer `attention.deliveryRead` from it and run `attention.deliveryTest` through the same sender each channel uses; a test of saved web-address text with no scheme and host sends nothing and answers `result: notAnAddress`, which the page reads as `Not a web address, so nothing was sent.` A locked or unavailable keychain refuses with `attention.delivery_store_unavailable`; a channel missing its address or password refuses with `attention.delivery_not_configured`.
- **Test:** none beyond T3.4 and T3.5, which exercise the senders these verbs call.
- **Spec coverage:** Spec-017 §Interfaces And Contracts (the delivery verbs)
- **Verifies invariant:** none

##### T3.4 — The web address

- **Files:** the web-address sender and its verbs' handlers in `packages/runtime-daemon/src/attention/delivery/` plus co-located tests.
- **Step:** `attention.webAddressSave` saves the address the person typed; the first save mints the signing secret and returns it once; `attention.webAddressSecretRotate` returns the new one once; `attention.webAddressRemove` removes both. The address and the secret are sealed through the workflow-secret keychain store. Send one Standard Webhooks-signed JSON `POST` per moment of the kinds under `Send`, never for a muted session's `Finished` or `Failed` or for a withdrawal, only while no app window is in front on any device (a Notify step always), through the workflow HTTP step's request path; a 2xx within 15 seconds is success and a redirect a failure; retry at 5 seconds, 5 minutes and 30 minutes; keep at most 100 waiting and drop and count the oldest past that; record `web_address_state` and the attempt count on the entry.
- **Test:** the saved address, path and query included, never appears in a reply, event, log or error, only its scheme and host; a message the sender signs verifies with the `standardwebhooks` library's `Webhook.verify` and a tampered body fails; a body built for a session whose transcript holds a sentence never contains it.
- **Spec coverage:** Spec-017 §Cross-Device Delivery (web address)
- **Verifies invariant:** I-016-5

##### T3.5 — The email digest

- **When:** built last of all, after every other unit ([cross-plan-dependencies.md §Platform order](../architecture/cross-plan-dependencies.md#platform-order)).
- **Files:** the digest scheduler and sender and the password verbs' handlers in `packages/runtime-daemon/src/attention/delivery/`; `nodemailer` in `packages/runtime-daemon/package.json`; the Notifications page in `features/settings/` (EXTEND — the digest section); plus co-located tests.
- **Step:** One timer, no polling: at most one email per `After` period, sent only when a moment qualifies (at least one period old, in no earlier email, a `Waiting on you` still unresolved or a `Finished`, `Failed` or Notify-step moment whose session or run is unseen, never a muted session's `Finished` or `Failed`); stamp `digested_at` on each entry it carries. Load Nodemailer on the first send; send over TLS only (port 465 from the start, 587 with `requireTLS`), refusing a server that will not encrypt before the password is written. `attention.mailPasswordSave` and `attention.mailPasswordRemove` seal and remove the password through the workflow-secret keychain store. A failure is written to the outcome row and never retried within the same period. Draw the Notifications page's digest section (T3.7) with its status line, its test and its search rows.
- **Test:** the password never appears in a reply, event, log line or error, including an SMTP refusal whose text echoes the user name; against a local SMTP server that offers no STARTTLS, `attention.deliveryTest` answers `notEncrypted` and the password is never written to the socket; a moment already in one digest is never in a second, across a daemon restart.
- **Spec coverage:** Spec-017 §Cross-Device Delivery (email digest); Spec-017 §Implementation Notes (the dependency)
- **Verifies invariant:** I-016-5

##### T3.6 — Push to a device with no live connection

- **Files:** `packages/runtime-daemon/src/attention/push/` (new) plus co-located tests; the plaintext notice in `packages/contracts/src/attention.ts` and `push.send`'s request in `packages/contracts/src/push.ts` (new), which Plan-025 Phase 5's senders read.
- **Step:** For each linked device, apply in order the device's own `Notify me outside the app` and kind switch (the copy it last handed over), the session's mute, the quiet rule (nothing while an app window is in front on any device, except a Notify step), then the path: nothing when the device has a live connection with a window in front, the device's own post when it has a live connection and no window in front, and a push when it has no live connection. Seal the notice on the machine to the device's push key (HPKE with X-Wing; RFC 8291 for Web Push) and call `push.send`, authenticated through the constructor-injected `DaemonCredentialProvider` (Plan-004 CP-004-6; Plan-015 CP-015-7 and T5.3 inject the real one), with the moment's id as the collapse id, `Waiting on you` and a Notify step at high priority, `Finished` and `Failed` at normal priority, and a 24-hour expiry; where the device's own `Show a count on the app icon` is on, the sealed notice carries the count waiting on this machine, which the device sums across machines for its icon (the iPhone extension's badge, the web client's Badging API, Android's launcher). Keep one `push_deliveries` row per device a push went to, so a withdrawal reaches exactly the devices that got the entry; a row goes when its entry is withdrawn or 24 hours after it was sent. Write nothing to any session log.
- **Test:** a muted session's `Finished` is never pushed while its `Waiting on you` is; no push goes out while an app window is in front on any device, except a Notify step's; what reaches `push.send` is sealed and holds no name in the clear; with the device's count switch on, the sealed notice carries the number waiting on this machine and, with it off, no count.
- **Spec coverage:** Spec-017 §Cross-Device Delivery (push; when the web address and push send)
- **Verifies invariant:** I-016-3, I-016-5

##### T3.7 — The Notifications page

- **Files:** the Notifications page in `features/settings/` plus co-located tests.
- **Step:** Draw the Notifications page: the two switches, the four kinds (grayed with `Turned off above.` while the master switch is off), the mute line, and the web address section with its status line and test, with their search rows. On the machine the page reads and writes the machine's settings file through `machineSettings`; on a phone app or the web client the switches and the kinds are the device's own, kept on the device and handed to each machine by `device.notificationSettingsSet` on every connection and every change. The web address section reads and writes through the delivery verbs. The digest section is T3.5's.
- **Test:** a switch changed on a phone app is kept on that phone and reaches each machine's copy, and no machine's settings file changes for it.
- **Spec coverage:** Spec-017 §The Console's Attention Surfaces; Spec-017 §Interfaces And Contracts
- **Verifies invariant:** none

## Rollout Order

1. Land the attention contracts, the projection, the gate and the mute
2. Enable the in-app bell, list and count, and the main process's notifications with the windowless start
3. Enable the web address, the email digest and push

## Rollback Or Fallback

- Disable OS notification delivery and keep the in-app attention projection only if platform hooks or routing regress. The web address and the email digest are off until the person turns them on, and each can be turned off on its own.

## Risks And Blockers

- Which Windows process may remove a toast through the toast history is unmeasured: if the daemon's Windows half may not, the app's own windowless program is run again with a withdraw verb. A probe on a Windows machine settles it.
- Banner mode and a click after the poster exits are accepted only on signed, packaged builds on macOS, Windows and Linux.
- A mailbox that refuses password sending (a work Microsoft 365 mailbox once Microsoft turns SMTP basic authentication off) cannot send the digest through the person's own account; sending for it needs an OAuth client registration the project does not hold. This is a gap in the requirement, not a narrower requirement.
- Whether Slack and Discord accept the web-address body's fields beside `text` is unmeasured.
- Aggregate session attention can drift if clients try to reconstruct it locally instead of consuming the canonical derived projection

## Design Decisions

The design decisions behind the plan body above.

- **D-016-1 — Plan-016 keeps no control-plane notification store. Type 2.** Every notification comes from the machine's own attention entries, and every delivery decision is made on the machine: the operating-system notification from the live projection, the push per device by the machine that seals it, and the web address and the email digest by the daemon. So the control plane holds no notification queue, no filter and no preference table; the switches are per machine and per device in each one's settings file, a session's mute is the session's own fact, and a push is a sealed delivery the relay cannot open and does not keep. A device with no live connection is reached by a push with a 24-hour expiry rather than by a queue resent on reconnect. **Type 2** because a control-plane store of notification content, once it holds rows, is personal data outside the machine that is hard to take back.
- **D-016-2 — The session-scoped aggregate is carried by an `AttentionItem` with no `runId`; severity aggregates, and trigger and `sourceEventId` come from a deterministically selected representative contributor. Type 1.** [Spec-017 §Required Behavior](../specs/017-notifications-and-attention-model.md#required-behavior) requires attention at both run and session scope, and [Spec-017 §Default Behavior](../specs/017-notifications-and-attention-model.md#default-behavior) makes the session view an aggregate of unresolved run signals — but the shared `AttentionItem` shape carries exactly one `trigger`, one `severity`, and one `sourceEventId`, leaving unstated which field carries the aggregate and where a derived item's canonical reference comes from. The rule is stated in full in §API And Transport Changes. Two properties are worth naming here. First, the resolution is **contract-shape-neutral**: because the representative is a real contributor rather than a synthesized placeholder, `sourceEventId` always resolves and stays non-optional, so [Spec-017 §Interfaces And Contracts](../specs/017-notifications-and-attention-model.md#interfaces-and-contracts)'s canonical-reference requirement holds without widening the type — no api-payload change rides this decision beyond an explanatory annotation. Second, the severity leg is spec-grounded while the selection chain is **plan-owned**: no Spec-017 clause fixes a tiebreak order, and the total ordering (severity, then `createdAt`, then `id`) is enforcement this plan designs so that two readers of one projection state cannot disagree about which contributor an aggregate names. Aggregates are read-projection-only and are never emitted as notifications, which is what keeps the rule confined to the read path. **Type 1** — a derivation rule over an unchanged shape is reversible by restating it.
- **D-016-3 — Attention operations ride the daemon transport; the only control-plane call is the sealed push. Type 1.** The [Attention Method-Name Registry](../architecture/contracts/attention-payloads.md#attention-method-name-registry) assigns `attention.projectionRead` (served live), `attention.bannerSettle`, `attention.seenUpdate` and the delivery verbs to the daemon JSON-RPC transport. It mints no `attention.subscribe`, because the projection is served live the way `command.list` is; no preference methods, because the preferences are the machine's settings file's keys; and no emit verb, because nothing about a notification crosses to the control plane except a push the machine has already sealed, which it hands over with `push.send` ([Plan-025](./025-remote-control.md) builds the senders). **Type 1** — a transport assignment and wire registration, reversible by restating before any code ships.
- **D-016-4 — `AttentionProjectionReadRequest` narrows by `scope` plus `runId`, with run scope requiring `runId` refused at parse. Type 1.** The canonical request carries `scope?: "run" | "session"` plus an optional `runId` (an optional field on the published shape, compatible per [ADR-017](../decisions/017-cross-version-compatibility.md)): `scope: "run"` **requires** `runId` (a run-scope read without a run identifier is refused at parse, never defaulted to all runs), and `runId` is admissible only with `scope: "run"` (a request cannot name a run while asking for the session aggregate or the full projection). Omitting `scope` reads the full projection — run-scoped items plus the aggregate; `scope: "session"` narrows to the aggregate alone. The rule is a schema-level Zod refinement stated in the contract comment, not service-layer convention. **Type 1** — an additive optional field plus a refusal rule, reversible by relaxing.
- **D-016-5 — One gate, applied once, when the daemon writes an entry. Type 1.** The master switch, the entry's kind switch and the session's mute are applied together when the daemon writes an entry, reading the machine's settings file at that moment with no copy and no watcher, and recorded as `bannerState: withheld`. The main process then posts only `pending` entries and reads no kind switch, a withheld entry starts no windowless program, and no preference gates a withdrawal. Deciding once keeps the machine's notification, the windowless start and the outside channels from disagreeing about the same entry. **Type 1** — a placement of an existing check, reversible by moving it.
