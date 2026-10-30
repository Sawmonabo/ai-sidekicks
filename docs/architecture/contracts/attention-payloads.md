# Attention Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-016 — Notifications And Attention Model

```ts
// `attention.subscribe`: the machine's whole attention projection, served live: the first emission
// is the whole projection, then one emission per change. The bell's count and its list, the app
// icon's count and the operating-system notification are all read from it, and from nothing else.
// With no session named, the whole projection across every session and workflow run, with each
// provider's build entries. Naming a session narrows by D-016-4: scope "run" requires runId, and
// runId is admissible only with scope "run". A scope goes only with a session: a request with a
// scope and no sessionId is refused at parse.
interface AttentionSubscribeRequest {
  sessionId?: SessionId;
  scope?: "run" | "session";
  runId?: RunId;
}
// One emission of the stream: the whole projection.
interface AttentionProjection {
  items: AttentionItem[];
}

interface AttentionItem {
  id: string;
  // The MOMENT this entry speaks for — the session or run and the episode it is in, or on a
  // `providerBuild` entry the provider and its build, minted by the projection and never composed
  // by a client: `run:<runId>`, `workflowRun:<workflowRunId>`, `plan:<planId>`,
  // `session:<sessionId>`, for a Notify step `notify:` and 32 hex digits of the BLAKE3 hash of its
  // run, node and execution index, and for a `providerBuild` entry `providerBuild:` and 32 hex
  // digits of the BLAKE3 hash of the provider and the build; each of the last two is also that
  // entry's `id`. Every form fits the 64 bytes a banner's tag and a push's collapse id hold. Every
  // operating-system notification carries it, so a subject that moves from waiting to finished
  // while nobody is looking REPLACES its banner in place instead of standing a second one beside
  // it: the waiting entry and the finished one that follows it share this id. It is deliberately
  // not `id` and deliberately not the state — an id per entry would post a second banner for the
  // same subject, and an id carrying the state would defeat the replacement it exists to make
  // possible. The notifications list groups by it too, one line per moment. The main process posts
  // from this projection and from nothing else: a `pending` entry only while no console window is
  // focused (a workflow's Notify step posts either way), and it withdraws the banner when the entry
  // resolves, when its session or run is deleted, or when the daemon stops keeping its entry (seen,
  // more than a day old and with no web-address message waiting), a Notify step's never — so
  // answering on another device clears it here. A `providerBuild` line leaves when the provider's
  // next build takes its place, at once, and a line for a build installed also a day after it was
  // recorded; a line for a build only available never leaves on a timer. With the app not running,
  // the daemon starts the app's own program with no window to post the banner, and that process
  // exits.
  momentId: string;
  sessionId?: SessionId; // absent exactly on a `providerBuild` entry, which belongs to no session
  runId?: RunId; // present on a run-scoped entry; absent on the session-scoped aggregate
  // The name the entry is shown under — the session's name, or the run's name on a run's entry;
  // an untitled session reads `New chat` for a chat and `New session` for a project session — and
  // the word the line reads after it (`Waiting on you`, `Finished`, `Failed`, or a Notify step's
  // own notice text). A banner says the name and the state and nothing else.
  displayName: string;
  stateWord: string;
  // The console draws four kinds from these: `Waiting on you` (`pendingApproval`, `pendingInput`;
  // counted, and withdrawn when resolved), `Finished` (`runCompleted`) and `Failed` (`runFailed`),
  // listed under `Earlier` and never counted, and a workflow's Notify step (`workflowNotify`),
  // listed under `Earlier`, never counted and never withdrawn. A Notify step is one informational
  // entry with no event of its own. A provider's new build (`providerBuild`) is none of the four:
  // one informational entry per build under `Earlier`, never counted, always `withheld` and
  // carried by no notification, push, web-address message or digest line; its line opens that
  // provider's section of Settings › Providers.
  trigger:
    | "pendingApproval"
    | "pendingInput"
    | "runCompleted"
    | "runFailed"
    | "workflowNotify"
    | "providerBuild";
  // present exactly on a `workflowNotify` entry, which is informational and carries its run: the
  // step that posted it
  stepId?: string;
  // Present exactly on a `providerBuild` entry: the line reads `Claude Code updated · 2.1.293 →
  // 2.1.294` with `What's new`, which opens the provider's official release notes for the new
  // version, or, with no `fromVersion`, a build only available to a provider the person keeps from
  // updating itself, `Claude Code 2.1.294 available`. `releaseNotesAddress` is that `https:`
  // address, minted by the provider's driver for the new version, present exactly with
  // `fromVersion`.
  providerBuild?: {
    provider: ProviderId;
    fromVersion?: string;
    toVersion: string;
    releaseNotesAddress?: string;
  };
  severity: "actionable" | "informational";
  // What became of the entry's banner; absent until the daemon decides it, and the main process
  // posts only a `pending` entry. The daemon writes `withheld` when it decides the entry for a kind
  // this machine's settings switch off, for the master switch off, or for a muted session's
  // `Finished` or `Failed`, and starts no windowless app for it, and `pending` otherwise; a
  // `providerBuild` entry is always `withheld`, written by no decision; the main process settles a
  // `pending` entry once through `attention.banner.settle`, so a banner is never posted twice. The
  // daemon itself writes `withdrawn` over a `pending` or `posted` entry when its moment resolves,
  // and over a `Finished` or `Failed` one on `session.muted`; when the entry is deleted with its
  // session or run, or retired once seen and more than a day old, the main process withdraws its
  // banner. A Notify step's is never withdrawn.
  bannerState?: "pending" | "posted" | "withheld" | "withdrawn";
  // Where the entry's message to the person's web address stands, and how many sends it took; both
  // present exactly when the entry is sent to a web address.
  webAddressState?: "pending" | "delivered" | "undelivered";
  webAddressAttemptCount?: number;
  // The canonical event that triggered this; absent on a `providerBuild` entry, which is derived
  // from its row in the daemon's record of each provider's builds.
  sourceEventId?: string;
  createdAt: string;
  // set once the state that produced the entry resolves; absent means outstanding
  resolvedAt?: string;
  // The entry's subject's seen fact: a session's entry reads its session's, a workflow-run entry
  // its run's; absent on an entry with no session.
  seen?: boolean;
}

// `attention.banner.settle`: called by this computer's main process alone: records what became of
// an entry's banner. A no-op once the entry is past `pending`. A settle from another device for
// this computer's entry is ignored: it answers `{}` and changes nothing, and only this computer's
// own subscriptions count as a main process connected.
interface AttentionBannerSettleRequest {
  entryId: string;
  state: "posted" | "withheld" | "withdrawn";
}

// `attention.seen.update`: marks a subject seen: a session, or a workflow run in it, which keeps a
// seen fact of its own. It is the one seen-or-unseen fact the sessions list's done dot, the bell's
// `Earlier` group and the email digest read. A runId the session does not hold is refused with
// `workflow.run.notFound`.
interface AttentionSeenUpdateRequest {
  subject: AttentionSeenSubject;
}
interface AttentionSeenSubject {
  sessionId: SessionId;
  runId?: WorkflowRunId; // present when a workflow run was opened rather than the session
}

// Delivery beyond this machine's screen. The switches are the machine's settings file's; these
// verbs hold the channels' secrets and report what each channel last did. Apart from the signing
// secret, returned once when it is minted or made new so the receiver can be set up, no secret is
// on a reply, an event, a log or an error. A call that takes nothing takes `EmptyPayload`, and one
// that reads nothing back answers `EmptyPayload`.
interface AttentionDeliveryOutcome {
  at: string;
  // storeUnavailable: the keychain refused, locked or unavailable, or the address is saved with its
  // signing secret missing or unreadable, so nothing was sent.
  result:
    | "delivered"
    | "refused"
    | "unreachable"
    | "timedOut"
    | "signInRefused"
    | "notEncrypted"
    | "storeUnavailable";
  cause?: "locked" | "unavailable" | "secretMissing"; // present exactly on storeUnavailable
  httpStatus: number | null; // null where the address gave no answer
  undelivered: number;
}
interface AttentionDeliveryListResponse {
  // `host`: the saved address's scheme and host, null exactly when nothing is saved.
  webAddress: { saved: boolean; host: string | null; lastOutcome: AttentionDeliveryOutcome | null };
  // `knownMailDomains`: the service's mail-server table's keys, aliases and domains, so the page
  // draws `Mail server`, `Port` and `User name` only when the address's domain, as it is typed, is
  // not in the table, matching its domain the way the service's lookup does.
  emailDigest: {
    passwordSaved: boolean;
    knownMailDomains: string[];
    lastOutcome: AttentionDeliveryOutcome | null;
  };
}
interface AttentionDeliveryTestRequest {
  channel: "webAddress" | "emailDigest";
}
// The web address's test posts `{text: "Test message from <machine>", kind: "test", at, machine,
// content}`, `content` equal to `text`, once, with no retry and no outcome row written; its
// outcome's `undelivered` is the channel's current count. The page settles on its result:
// `delivered` `Sent. The address answered 200.`, `refused` `The address answered <status>.`,
// `timedOut` `The address did not answer in 15 seconds.`, `unreachable` `The address could not be
// reached.`, and `storeUnavailable` `Nothing was sent: the keychain is locked.` or, with `cause:
// secretMissing`, `Nothing was sent: the signing secret is missing. Make a new secret.` The refusal
// `attention.delivery.storeUnavailable` settles the test with the same line its cause names.
interface AttentionDeliveryTestResponse {
  outcome: AttentionDeliveryOutcome;
}
interface AttentionMailPasswordUpdateRequest {
  password: string; // write-only: sealed in the credential store or secrets.json, never read back
}
interface AttentionWebAddressUpdateRequest {
  address: string; // an http or https address with a host; any other text is refused
}
interface AttentionWebAddressUpdateResponse {
  host: string; // the saved address's scheme and host
  signingSecret: string | null; // minted by the first save and shown once; null on every later save
}
interface AttentionWebAddressSecretRotateResponse {
  signingSecret: string; // shown once
}
// `attention.webAddress.delete` waits for the attempt in flight, then removes the address, its
// signing secret and the channel's outcome row, and drops every waiting message, uncounted.
// Refusals: `attention.delivery.storeUnavailable` (`cause: locked | unavailable | secretMissing`),
// `attention.delivery.notConfigured` (`missing: address | password`; also `secret.rotate` with no
// address saved) and `attention.webAddress.notAnAddress` (`update` on text that is no address).
```

> **Scope and aggregate carrier (Plan-016 D-016-2).** `runId` is the scope discriminator: an item carrying it is run-scoped, an item omitting it is the session-scoped aggregate that [Spec-017 §Required Behavior](../../specs/017-notifications-and-attention-model.md#required-behavior) requires alongside run scope. There is no separate aggregate type and no aggregate-only field. On an aggregate, `severity` carries the aggregation over its contributors, the session's unresolved waiting entries and its informational entries not yet seen — `actionable` while **any** contributor is actionable, `informational` only when every contributor is — per [Spec-017 §Default Behavior](../../specs/017-notifications-and-attention-model.md#default-behavior), while `trigger` and `sourceEventId` are taken from one deterministically selected representative contributor: highest severity first (`actionable` before `informational`), then earliest `createdAt`, then lexicographically smallest `id`. Because the representative is a real contributor rather than a synthesized placeholder, `sourceEventId` always resolves on an aggregate and stays non-optional. Aggregates are read-projection-only: `attention.subscribe` returns them and no delivery carries one — a banner, a web-address message or an email line speaks for the single canonical trigger that caused it, so no aggregate is ever delivered and no per-contributor fan-out is inferred from one. Canonical statement: [Plan-016 §API And Transport Changes](../../plans/016-notifications-and-attention-model.md#api-and-transport-changes) and [Plan-016](../../plans/016-notifications-and-attention-model.md) D-016-2.

## Attention Method-Name Registry

Plan-016's attention surface is exposed as the `attention.*` methods below, all on the **daemon JSON-RPC transport**: the attention projection is a daemon-local projection rebuilt from canonical session and run state per [ADR-016](../../decisions/016-shared-event-sourcing-scope.md) — the `transcript.*` posture in transcript-payloads.md — and the delivery channels' secrets and outcomes are this machine's. They register against the Plan-005-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out (the §2 `crates/sidekicks-ipc/src/` row's Plan-016 `attention.*` entry). Method names follow the [wire-name grammar](./local-ipc-payloads.md#wire-name-grammar).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `attention.subscribe` | `subscription` | `AttentionSubscribeRequest` | `SubscribeAckResponse`, then `AttentionProjection` emissions |
| `attention.banner.settle` | `mutation` | `AttentionBannerSettleRequest` | `EmptyPayload` |
| `attention.seen.update` | `mutation` | `AttentionSeenUpdateRequest` | `EmptyPayload` |
| `attention.delivery.list` | `query` | `EmptyPayload` | `AttentionDeliveryListResponse` |
| `attention.delivery.test` | `mutation` | `AttentionDeliveryTestRequest` | `AttentionDeliveryTestResponse` |
| `attention.mailPassword.update` | `mutation` | `AttentionMailPasswordUpdateRequest` | `EmptyPayload` |
| `attention.mailPassword.delete` | `mutation` | `EmptyPayload` | `EmptyPayload` |
| `attention.webAddress.update` | `mutation` | `AttentionWebAddressUpdateRequest` | `AttentionWebAddressUpdateResponse` |
| `attention.webAddress.secret.rotate` | `mutation` | `EmptyPayload` | `AttentionWebAddressSecretRotateResponse` |
| `attention.webAddress.delete` | `mutation` | `EmptyPayload` | `EmptyPayload` |

**One live feed.** `attention.subscribe` is a live read in the manner of `agent.command.subscribe`: its first emission is the whole projection and each later one follows a change, so the bell, the list, the app icon's count and the operating-system notification read one feed, the main process holding its own subscription beside the renderer's. `attention.banner.settle` is called by the main process alone, including the windowless process the daemon starts to post a banner while no app runs, which settles the entry and exits.

**The preferences are the machine's settings file's.** No `attention.*` verb carries a notification preference, and the daemon keeps none of its own. `Notify me outside the app`, the four kinds beneath it (`Waiting on you`, `Finished`, `Failed`, `Notify steps`, each on by default), the web address's switch and kinds, and the email digest's settings other than its password are this device's, kept in the machine's settings file (settings-payloads.md §Settings Surface Reads And Writes); the daemon reads them, with the session's mute, each time it writes an entry, and no preference gates a withdrawal.

**Delivery off this screen is the machine's own.** `Email me what I have not seen` is off by default. When on, the service sends at most one email per period — an hour, four hours or a day, a day by default — through the person's own mail account, sent through `lettre` over TLS only (TLS from the start where the server's entry is marked secure, else STARTTLS, required, on its port or 587), so a server that will not encrypt is refused before the password is written; the map from an address's domain to its mail server is Nodemailer's maintained well-known services list (MIT-0), carried as data. It lists each `Waiting on you` still unresolved and each `Finished`, `Failed` or Notify-step moment whose session or run has not been opened since, each once, never a muted session's `Finished` or `Failed`, and names each session or run, its state, its time and its `sidekicks://` address, never what was said. `Send to a web address` is off by default. When on, the service sends one Standard Webhooks-signed JSON `POST` per moment of the kinds picked for it (`text`, `kind`, `state`, `subject`, `momentId`, `at`, `machine`, `link` and `content`, equal to `text`; never what was said), never for a muted session's `Finished` or `Failed` and nothing for a withdrawal, and only while no console window is in front on any device, except that a workflow's Notify step always sends. The address is saved only with an `http` or `https` scheme and a host; success is a 2xx answer within 15 s and a redirect is a failure; a failed send is retried at 5 s, 5 min and 30 min, a try the keychain refuses counting as `storeUnavailable`, with at most 100 waiting, the oldest dropped and counted past that, and turning the switch off drops what waits without counting it. The mail password, the address and its signing secret are sealed in the operating system's credential store, or in the daemon's `secrets.json` file on Linux and on a Mac whose secrets are in it; the address is shown back as its scheme and host only. A push to another of the person's devices is sealed on this machine and sent through `device.push.send` ([Spec-027](../../specs/027-remote-control.md)); the control plane keeps no notification queue, filter or preference. The Rust types live in `crates/sidekicks-contracts/src/attention.rs`; the generated TypeScript keeps `packages/contracts/src/attention.ts`, per the api-payload-contracts.md §Source-of-Truth Policy.
