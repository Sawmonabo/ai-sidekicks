# Attention Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-016 — Notifications And Attention Model

```ts
// AttentionProjectionRead — the machine's whole attention projection, served live: the first emission is
// the whole projection, then one emission per change. The bell's count and its list, the app icon's count
// and the operating-system notification are all read from it, and from nothing else.
// With no session named, the whole projection across every session and workflow run, with each
// provider's build entries. Naming a session narrows by D-016-4: scope "run" requires runId, and runId is admissible only with scope "run".
interface AttentionProjectionReadRequest {
  sessionId?: SessionId;
  scope?: "run" | "session";
  runId?: RunId;
}
interface AttentionProjectionReadResponse {
  items: AttentionItem[]; // one emission of the stream
}

interface AttentionItem {
  id: string;
  // The MOMENT this entry speaks for — the session or run and the episode it is in, or on a
  // `provider_build` entry the provider and its build, minted by the
  // projection and never composed by a client. Every operating-system notification carries it, so a
  // subject that moves from waiting to finished while nobody is looking REPLACES its banner in place
  // instead of standing a second one beside it: the waiting entry and the finished one that follows it
  // share this id. It is deliberately not `id` and deliberately not the state — an id per entry would
  // post a second banner for the same subject, and an id carrying the state would defeat the
  // replacement it exists to make possible. The notifications list groups by it too, one line per
  // moment. The main process posts from this projection and from nothing else: a `pending` entry only
  // while no console window is focused (a workflow's Notify step posts either way), and it withdraws the
  // banner when the entry resolves — so answering on another device clears it here. With the app not
  // running, the daemon starts the app's own program with no window to post the banner, and that process
  // exits.
  momentId: string;
  sessionId?: SessionId; // absent exactly on a `provider_build` entry, which belongs to no session
  runId?: RunId; // present on a run-scoped entry; absent on the session-scoped aggregate
  // The name the entry is shown under — the session's name, or the run's name on a run's entry — and the
  // word the line reads after it (`Waiting on you`, `Finished`, `Failed`, or a Notify step's own notice
  // text). A banner says the name and the state; `summary` never becomes a notification's body.
  displayName: string;
  stateWord: string;
  // The console draws four kinds from these: `Waiting on you` (`pending_approval`, `pending_input`;
  // counted, and withdrawn when resolved), `Finished` (`run_completed`) and `Failed` (`run_failed`), listed
  // under `Earlier` and never counted, and a workflow's Notify step (`workflow_notify`), listed under
  // `Earlier`, never counted and never withdrawn. A Notify step is one informational entry with no event
  // of its own. A provider's new build (`provider_build`) is none of the four: one informational entry per
  // build under `Earlier`, never counted, written `withheld` and carried by no notification, push,
  // web-address message or digest line; its line opens that provider's section of Settings › Providers.
  trigger:
    | "pending_approval"
    | "pending_input"
    | "run_completed"
    | "run_failed"
    | "workflow_notify"
    | "provider_build";
  stepId?: string; // present exactly on a `workflow_notify` entry, which is informational and carries its run: the step that posted it
  // Present exactly on a `provider_build` entry: the line reads `Claude Code updated · 2.1.293 → 2.1.294`
  // with `What's new`, which opens the provider's official release notes for the new version, or, with
  // no `fromVersion`, a build only available to a provider the person keeps from updating itself,
  // `Claude Code 2.1.294 available`.
  providerBuild?: { provider: ProviderName; fromVersion?: string; toVersion: string };
  severity: "actionable" | "informational";
  summary: string; // one line a surface renders: prose, not an identifier
  // What became of the entry's banner. The daemon writes `withheld` when it writes the entry for a kind
  // this machine's settings switch off, for the master switch off, for a muted session's `Finished` or
  // `Failed`, and for every `provider_build` entry, and starts no windowless app for it, and `pending`
  // otherwise; the main process settles a `pending` entry once through `attention.bannerSettle`, so a
  // banner is never posted twice.
  bannerState: "pending" | "posted" | "withheld" | "withdrawn";
  // Where the entry's message to the person's web address stands, and how many sends it took; both
  // present exactly when the entry is sent to a web address.
  webAddressState?: "pending" | "delivered" | "undelivered";
  webAddressAttemptCount?: number;
  // The canonical event that triggered this; absent on a `provider_build` entry, which is derived from its
  // row in the daemon's record of each provider's builds.
  sourceEventId?: string;
  createdAt: string;
  resolvedAt?: string; // set once the state that produced the entry resolves; absent means outstanding
  // The one seen-or-unseen fact the daemon keeps, which the session's row reads too; absent on an entry
  // with no session.
  seen?: boolean;
}

// AttentionBannerSettle — called by the main process alone: records what became of an entry's banner. A
// no-op once the entry is past `pending`.
interface AttentionBannerSettleRequest {
  entryId: string;
  state: "posted" | "withheld" | "withdrawn";
}
interface AttentionBannerSettleResponse {}

// AttentionSeenUpdate — marks a session seen: the one seen-or-unseen fact the sessions list's done dot
// and the email digest read.
interface AttentionSeenUpdateRequest {
  sessionId: SessionId;
}
interface AttentionSeenUpdateResponse {}

// Delivery beyond this machine's screen. The switches are the machine's settings file's; these verbs hold
// the channels' secrets and report what each channel last did. Apart from the signing secret, returned
// once when it is minted or made new so the receiver can be set up, no secret is on a reply, an event, a
// log or an error.
interface AttentionDeliveryOutcome {
  at: string;
  // notAnAddress: a test of saved web-address text with no scheme and host; nothing was sent.
  result:
    | "delivered"
    | "refused"
    | "unreachable"
    | "timedOut"
    | "signInRefused"
    | "notEncrypted"
    | "notAnAddress";
  httpStatus?: number;
  undelivered: number;
}
interface AttentionDeliveryReadRequest {}
interface AttentionDeliveryReadResponse {
  webAddress: { saved: boolean; host: string | null; lastOutcome: AttentionDeliveryOutcome | null };
  emailDigest: { passwordSaved: boolean; lastOutcome: AttentionDeliveryOutcome | null };
}
interface AttentionDeliveryTestRequest {
  channel: "webAddress" | "emailDigest";
}
interface AttentionDeliveryTestResponse {
  outcome: AttentionDeliveryOutcome;
}
interface AttentionMailPasswordSaveRequest {
  password: string; // write-only: sealed in the credential store or secrets.json, never read back
}
interface AttentionMailPasswordSaveResponse {}
interface AttentionMailPasswordRemoveRequest {}
interface AttentionMailPasswordRemoveResponse {}
interface AttentionWebAddressSaveRequest {
  address: string;
}
interface AttentionWebAddressSaveResponse {
  host: string | null; // null for saved text with no scheme and host, which reads masked
  signingSecret?: string; // present only on the first save, which mints it
}
interface AttentionWebAddressSecretRotateRequest {}
interface AttentionWebAddressSecretRotateResponse {
  signingSecret: string; // shown once
}
interface AttentionWebAddressRemoveRequest {} // removes the address and its signing secret
interface AttentionWebAddressRemoveResponse {}
// Refusals: `attention.delivery_store_unavailable` (`cause: locked | unavailable`) and
// `attention.delivery_not_configured` (`missing: address | password`).
```

> **Scope and aggregate carrier (Plan-016 D-016-2).** `runId` is the scope discriminator: an item carrying it is run-scoped, an item omitting it is the session-scoped aggregate that [Spec-017 §Required Behavior](../../specs/017-notifications-and-attention-model.md#required-behavior) requires alongside run scope. There is no separate aggregate type and no aggregate-only field. On an aggregate, `severity` carries the aggregation — `actionable` while **any** unresolved contributor (a run-scoped item or a pending request) is actionable, `informational` only when every contributor is — per [Spec-017 §Default Behavior](../../specs/017-notifications-and-attention-model.md#default-behavior), while `trigger` and `sourceEventId` are taken from one deterministically selected representative contributor: highest severity first (`actionable` before `informational`), then earliest `createdAt`, then lexicographically smallest `id`. Because the representative is a real contributor rather than a synthesized placeholder, `sourceEventId` always resolves on an aggregate and stays non-optional. Aggregates are read-projection-only: `attention.projectionRead` returns them and no delivery carries one — a banner, a web-address message or an email line speaks for the single canonical trigger that caused it, so no aggregate is ever delivered and no per-contributor fan-out is inferred from one. Canonical statement: [Plan-016 §API And Transport Changes](../../plans/016-notifications-and-attention-model.md#api-and-transport-changes) and [Plan-016](../../plans/016-notifications-and-attention-model.md) D-016-2.

## Attention Method-Name Registry

Plan-016's attention surface is exposed as the `attention.*` methods below, all on the **daemon JSON-RPC transport**: the attention projection is a daemon-local projection rebuilt from canonical session and run state per [ADR-016](../../decisions/016-shared-event-sourcing-scope.md) — the `transcript.*` posture in transcript-payloads.md — and the delivery channels' secrets and outcomes are this machine's. They register against the Plan-005-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out (the §2 `packages/runtime-daemon/src/ipc/` row's Plan-016 `attention.*` entry). Method tails are camelCase per the convention the Approval Method-Name Registry records.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `attention.projectionRead` | `subscription` | `AttentionProjectionReadRequest` | `AttentionProjectionReadResponse` (stream) |
| `attention.bannerSettle` | `mutation` | `AttentionBannerSettleRequest` | `AttentionBannerSettleResponse` |
| `attention.seenUpdate` | `mutation` | `AttentionSeenUpdateRequest` | `AttentionSeenUpdateResponse` |
| `attention.deliveryRead` | `query` | `AttentionDeliveryReadRequest` | `AttentionDeliveryReadResponse` |
| `attention.deliveryTest` | `mutation` | `AttentionDeliveryTestRequest` | `AttentionDeliveryTestResponse` |
| `attention.mailPasswordSave` | `mutation` | `AttentionMailPasswordSaveRequest` | `AttentionMailPasswordSaveResponse` |
| `attention.mailPasswordRemove` | `mutation` | `AttentionMailPasswordRemoveRequest` | `AttentionMailPasswordRemoveResponse` |
| `attention.webAddressSave` | `mutation` | `AttentionWebAddressSaveRequest` | `AttentionWebAddressSaveResponse` |
| `attention.webAddressSecretRotate` | `mutation` | `AttentionWebAddressSecretRotateRequest` | `AttentionWebAddressSecretRotateResponse` |
| `attention.webAddressRemove` | `mutation` | `AttentionWebAddressRemoveRequest` | `AttentionWebAddressRemoveResponse` |

**One live feed.** `attention.projectionRead` is a live read in the manner of `command.list`: its first emission is the whole projection and each later one follows a change, so the bell, the list, the app icon's count and the operating-system notification read one feed, the main process holding its own subscription beside the renderer's. `attention.bannerSettle` is called by the main process alone, including the windowless process the daemon starts to post a banner while no app runs, which settles the entry and exits.

**The preferences are the machine's settings file's.** No `attention.*` verb carries a notification preference, and the daemon keeps none of its own. `Notify me outside the app`, the four kinds beneath it (`Waiting on you`, `Finished`, `Failed`, `Notify steps`, each on by default), the web address's switch and kinds, and the email digest's settings other than its password are this device's, kept in the machine's settings file (settings-payloads.md §Settings Surface Reads And Writes); the daemon reads them, with the session's mute, each time it writes an entry, and no preference gates a withdrawal.

**Delivery off this screen is the machine's own.** `Email me what I have not seen` is off by default. When on, the service sends at most one email per period — an hour, four hours or a day, a day by default — through the person's own mail account, sent by Nodemailer over TLS only (on 465 from the start, on 587 with a required STARTTLS, so a server that will not encrypt is refused before the password is written). It lists each `Waiting on you` still unresolved and each `Finished`, `Failed` or Notify-step moment whose session or run has not been opened since, each once, never a muted session's `Finished` or `Failed`, and names each session or run, its state, its time and its `sidekicks://` address, never what was said. `Send to a web address` is off by default. When on, the service sends one Standard Webhooks-signed JSON `POST` per moment of the kinds picked for it (`text`, `kind`, `state`, `subject`, `momentId`, `at`, `machine`, `link`; never what was said), never for a muted session's `Finished` or `Failed` and nothing for a withdrawal, and only while no console window is in front on any device, except that a workflow's Notify step always sends. The address is whatever the person typed; success is a 2xx answer within 15 s and a redirect is a failure; a failed send is retried at 5 s, 5 min and 30 min, with at most 100 waiting, the oldest dropped and counted past that. The mail password, the address and its signing secret are sealed in the operating system's credential store, or in the daemon's `secrets.json` file where that store cannot be used; the address is shown back as its host only, and text with no scheme and host, saved as typed like any other, reads masked with no host while each message to it fails and counts as undelivered. A push to another of the person's devices is sealed on this machine and sent through `push.send` ([Spec-027](../../specs/027-remote-control.md)); the control plane keeps no notification queue, filter or preference. Canonical Zod schemas live in `packages/contracts/src/attention.ts` per the api-payload-contracts.md §Source-of-Truth Policy.
