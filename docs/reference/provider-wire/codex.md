# Codex Wire Reference

Pinned wire reference for the Codex `app-server` JSON-RPC protocol as driven by `codex-driver`. See the [family README](README.md) for the TRUST / PROVENANCE vocabulary this file uses.

## Version pin

| Field | Value |
| --- | --- |
| Pinned version | `codex-cli 0.150.1` — the `latest` dist-tag of `@openai/codex` at this pin's authoring |
| Verified-equivalent build | none needed — the generation below was produced from the locally installed `0.150.1` build itself, which is also the registry's `latest`. The previous pin `0.149.1` was regenerated alongside it from an npm tarball, purely to compute the set difference recorded below; it is the **prior** pin, not an equivalent one. |
| Supported floor | `0.141.0` — the previous pin, retained as the oldest release `codex-driver` accepts |
| Primary anchor | the binary's own **Generated schema** (canonical over prose docs), plus the tagged upstream source `openai/codex` `rust-v0.150.1` for what the generator cannot express |
| Regenerated | 2026-08-28 |

**Trust framing (read before citing any shape below).** Every shape in this file is **Verified** trust **at `0.150.1`**, on **Generated schema** provenance unless a claim says otherwise. As at the previous pin, this one _is_ the current `latest` — so there is no newer stable to read it against today, and the Provisional-beyond-the-pin caveat attaches to whatever release lands next rather than to one that already exists. Codex ships a minor every 1–2 weeks plus near-daily alphas (the `alpha` dist-tag stood at `0.151.0-alpha.11` at this pin's authoring), so a consumer re-verifies its load-bearing shapes against the then-installed binary rather than trusting this pin.

**Additive-only across the floor.** Measured by set difference between the `0.141.0` and `0.150.1` default generations, both generated into scratch `CODEX_HOME`s (`0.141.0` installed from the npm registry at its exact version, `0.150.1` the locally installed build): `ClientRequest` 85 → 95 methods (**+10, none removed**), `ServerNotification` 66 → 79 (**+13, none removed**), `ServerRequest` 10 → 10, `ClientNotification` 1 → 1. No method string the floor speaks was withdrawn. The last hop of that span, `0.149.1` → `0.150.1`, was measured the same way and is **+4 on `ServerNotification` alone, none removed**: `mcpServer/event/stream/notification`, `thread/realtime/item/started`, `thread/realtime/item/transcript/delta`, and `thread/realtime/item/completed`. The three item-scoped realtime names are **additions beside** the older `thread/realtime/itemAdded` / `…/transcript/delta` / `…/transcript/done`, which are all still present — nothing was renamed. The breaks over that span are **type-level, not method-level** — see [Breaking type changes across the floor](#breaking-type-changes-across-the-floor). Counting basis is the one the family README fixes: default (non-experimental) generation, one entry per arm of the generated union root.

## Regeneration

The Codex wire is regenerated from the pinned binary, never hand-transcribed. Both subcommands are still `[experimental]` at `0.150.1` and nested under `app-server` (they are not top-level — re-verified against `codex app-server --help` at this pin):

```
codex app-server generate-json-schema --out <DIR>   # JSON Schema bundle
codex app-server generate-ts          --out <DIR>   # TypeScript bindings (ts-rs)
```

At `0.150.1` the JSON Schema run emits 37 top-level files — the four protocol roots `ClientRequest.json`, `ServerRequest.json`, `ServerNotification.json`, `ClientNotification.json`, per-type files, and the aggregates `codex_app_server_protocol.schemas.json` / `…v2.schemas.json` — plus `v1/` and `v2/` subdirectories (256 files in `v2/`, up from 252 at `0.149.1`). The TypeScript run emits a parallel tree: 92 top-level files plus `v2/` (595 files, up from 570) and `serde_json/`. Both splits are the same as at `0.141.0`: a **legacy top-level set** and a **`v2/` subdirectory** holding the modern protocol. **Both** subcommands take `--experimental`, which adds experimental methods and fields to the output; the shapes pinned here are from the default (non-experimental) generation.

## Method namespace

The wire has two coexisting method-naming styles at `0.150.1` (the shapes below are Verified from `ClientRequest.json` / `ServerRequest.json` / `ServerNotification.json`):

- **Legacy — bare camelCase, no slash.** A small residual set: client requests `initialize`, `fuzzyFileSearch`; server requests `execCommandApproval`, `applyPatchApproval`; the client notification `initialized`; server notifications `error`, `warning`, `configWarning`, `deprecationNotice`, `guardianWarning`.
- **Modern — slash-namespaced paths** (their generated types live under `v2/`). This is where the capability surface this project drives lives: `thread/*`, `turn/*`, `account/*`, `config/*`, `mcpServer*/*`, `permissionProfile/*`, `review/start`. Note the paths are slash-namespaced method strings (e.g. `thread/rollback`); they are **not** prefixed with a literal `v2/` on the wire — the `v2/` is the generated-file layout, not a method-string segment.

`ClientRequest` at `0.150.1` unions 95 client-request methods across both styles — the one root that did not move across this pin hop.

## The experimental gate — a runtime filter, not a schema filter

**This is the highest-consequence correction at this pin, and the generated schema alone cannot show it.** Presence of a method or notification in the default-generated schema does **not** mean a default connection receives it.

**The generator gates requests but not notifications — measured.** Both generator subcommands take an `--experimental` flag ("Include experimental methods and fields in the generated output"). Running both generations from the same `0.150.1` binary and differencing their JSON-schema union roots shows the filter is applied asymmetrically:

| Union root | Default generation | `--experimental` generation | Difference |
| --- | --- | --- | --- |
| `ClientRequest` | 95 | 153 | **+58**, including all six `thread/realtime/*` client requests |
| `ServerRequest` | 10 | 11 | +1 (`currentTime/read`) |
| `ServerNotification` | 79 | 79 | **none — the two sets are identical** |
| `ClientNotification` | 1 | 1 | none |

The same comparison at the **floor** shows the identical asymmetry — `ClientRequest` 85 vs 119 experimental (+34), `ServerNotification` 66 vs 66 **identical** — and the previous pin sat between them at 95 vs 150 (+55) and 75 vs 75, so this is the mechanism's steady behavior across the supported range, not an artifact of one release.

So for **requests**, the default schema is honest: what it omits, a default connection genuinely cannot call. For **notifications**, the default schema tells you nothing — every experimental notification is in it. The gate for notifications therefore has to live at runtime, and it does.

`initialize` carries `capabilities: InitializeCapabilities | null`, whose first field is `experimentalApi: boolean` ("Opt into receiving experimental API methods and fields", verbatim from the generated `InitializeCapabilities.ts`). The upstream source at `rust-v0.150.1` shows what that flag gates on the outbound path (Upstream source provenance, Verified — `codex-rs/app-server/src/transport.rs`, `should_skip_notification_for_connection`): the function returns `true` — skip — when `envelope.notification.experimental_reason().is_some()` and the connection's `experimental_api_enabled` is unset. The notification is dropped silently, with no error, no `deprecationNotice`, and no signal of any kind that the client is missing events.

At `0.150.1`, **23 of the 79 default-generated server notifications are gated**: all eleven `thread/realtime/*` (see below), plus `mcpServer/event/stream/notification`, `thread/reverted`, `thread/queue/changed`, `project/changed`, `thread/project/updated`, `thread/environment/connected`, `thread/environment/disconnected`, `thread/settings/updated`, `autoApprovalReview/strictReviewRequired`, `process/outputDelta`, `process/exited`, and `turn/moderationMetadata`. That is up from 19 of 75 at `0.149.1`: **every one of this hop's four new notifications carries a marker**, so the gated share grew while the ungated surface did not move at all. A driver that reads the generated `ServerNotification` union as its delivery contract will therefore expect close to a third of the notification surface it never receives.

**Why 23 is a total and not a floor.** `experimental_reason()` has two sources, and both were re-checked at this pin. A variant may carry an explicit `#[experimental(…)]` marker in the `server_notification_definitions!` block — 23 do, enumerated above. Failing that, `experimental_reason_expr!` falls through to the **params type's** own `ExperimentalApi` implementation, so a variant with no marker of its own is still gated if its params type is. At this pin that fallthrough contributes nothing: of the 30 types deriving `ExperimentalApi` across `app-server-protocol/src/protocol/v2/`, **none is a notification params type** (they are request params, responses, and config structs — `TurnStartParams` among them). That count is **unchanged from `0.149.1`** — the same 30 types, the same absence of a notification params type — so this hop's four additions are gated by their own markers and by nothing else. Re-verifying the total means re-running both checks, not just grepping for the attribute.

**Source declares 81; the binary generates 79 — count the generated schema.** The `server_notification_definitions!` invocation at `rust-v0.150.1` lists 81 variants, but the `0.150.1` binary's own default generation emits 79 arms. The two that do not reach the schema are `rawResponse/completed` and `rawResponseItem/completed` — the same two as at `0.149.1`, where the block listed 77 against a generated 75; **neither carries an experimental marker**, so the numerator above is unaffected and the denominator is the generated 79, per this family's counting basis. Anyone re-deriving 23-of-N from the source block alone will get the wrong denominator.

`InitializeCapabilities` also carries `optOutNotificationMethods?: Array<string> | null` — "Exact notification method names that should be suppressed for this connection" — evaluated by the same function. Suppression is thus **two-sourced**: the experimental marker, and the client's own opt-out list.

**The gate is not notification-only — one server-request is gated too, by the other mechanism.** The "default schema is honest" reading above holds for `ClientRequest`: the +55 the experimental generation adds there are genuinely uncallable on a default connection. It does **not** hold for `ServerRequest`. `item/tool/requestUserInput` sits **inside** the default-generated 10 — the default-vs-experimental delta on that root is the single unrelated `currentTime/read`, unchanged at this pin — yet its generated definition carries the marker "EXPERIMENTAL - Request input from the user for a tool call.", and a default app-server session never delivers it (see [Server-requests](#server-requests--the-callback--interactive--approval-surface-codex--daemon)). The mechanism is the **params type's own `ExperimentalApi` derivation** — the request-side half of the same fallthrough the 19-is-a-total argument checks on the notification side — not the transport's `should_skip_notification_for_connection`, which sees no request. So the negotiation-gated surface at this pin spans **both directions of the wire**: **23 of the 79 server notifications, plus 1 of the 10 server requests**. A consumer sizing its opt-in decision from the notification count alone undercounts by one, and misses the only one of the twenty-four that the daemon must answer back on.

## Refusal shapes on the client-request channel

Three distinct refusals share one JSON-RPC code at this pin, and a consumer that discriminates on the code alone gets all three wrong (added 2026-08-30; **Binary probe**, **Verified** at `0.150.1`, measured by a purpose-written stdio client driving `codex app-server` through `initialize` → `initialized` on a **default** connection, then issuing one request per case and recording the reply verbatim; no thread was started, no turn was sent, and credential posture was read-only throughout).

| What was sent | Code | Message (verbatim, name substituted) |
| --- | --- | --- |
| a method string the deserializer does not accept | `-32600` | `` Invalid request: unknown variant `zzq/nonexistent_method`, expected one of `initialize`, `server/diagnostics`, `thread/start`, … `` |
| an accepted method, with no params | `-32600` | `` Invalid request: missing field `threadId` `` — measured identically for `turn/steer`, `thread/goal/set`, and `thread/fork` |
| an accepted method the connection is not entitled to | `-32600` | `server/diagnostics requires experimentalApi capability` |

`-32601`, the standard method-not-found spelling, was not observed at this pin for any of the three.

**The discriminator is the message, and specifically the deserializer's own `unknown variant` enumeration.** Only the first row names a method the connection cannot call; the other two are answers from a method that exists. A consumer reading `-32600` as "no such method" therefore concludes that `turn/steer` and `thread/goal/set` are absent from every build, because both take a thread identity a bare probe does not compose.

Two further properties of that enumeration, and both matter to anyone parsing it:

- It lists the **deserializer's** accepted variants, which is a superset of the default-generated `ClientRequest` root: experimental methods are in it and are still refused by the third row above. **Enumeration membership is not availability** — the same rule this family's Claude reference states for its own control-request census.
- The identical `unknown variant` wording appears for enums nested **inside** an accepted request. Sending the withdrawn `AskForApproval` arm (see [Breaking type changes](#breaking-type-changes-across-the-floor)) draws `` Invalid request: unknown variant `on-failure`, expected one of `untrusted`, `on-request`, `granular`, `never` `` — a message about a field's value, not about the method. So the refused variant the message names must be compared against the method string that was sent; a parser that only looks for the phrase reads a rejected parameter as a missing method.

## Capability shapes

Shapes relevant to the capabilities this project normalizes, pinned from the `0.150.1` generation. Every generated type reproduced below is **byte-identical at `0.149.1` and `0.150.1` with exactly one exception** — `SkillMetadata`, nested inside `SkillsListResponse`, which gained one optional field at this pin (measured 2026-08-31; see [`skills/*`](#skills--the-skill-surface)). Apart from that one field, the pin hop moved four notification arms and nothing else this section names. The identity claim was re-measured type by type against the `0.149.1` generation rather than carried. Field notation follows the generated TypeScript (`?` = optional, `| null` = nullable).

### `thread/rollback` — session time-travel (conversation leg)

```
ThreadRollbackParams = { threadId: string, numTurns: number }   // numTurns >= 1
```

**Deprecated upstream at this pin — the deprecation is now in the generated type itself.** At `0.141.0` the deprecation existed only as prose on upstream `main`; from `0.149.1` onward the generated `v2/ThreadRollbackParams.ts` carries it as a doc comment on the type, unchanged at `0.150.1` and quoted verbatim:

> DEPRECATED: `thread/rollback` will be removed soon.

The upstream app-server README at `rust-v0.150.1` says the same and adds a second constraint, verbatim: "`thread/rollback` — deprecated and will be removed soon. … **Paginated threads do not support rollback.**" The method is nonetheless still present in the default `ClientRequest` union at this pin and is not marked experimental, so it remains callable — **Verified present, Provisional as a target to build on.**

The params type also retains its load-bearing `numTurns` doc comment unchanged from the floor, quoted verbatim:

> The number of turns to drop from the end of the thread. Must be >= 1. This only modifies the thread's history and does not revert local file changes that have been made by the agent. Clients are responsible for reverting these changes.

That sentence is the primary-source basis for splitting rollback into two legs: the provider method reverts the **conversation** only; **file** restoration is the daemon's responsibility (the turn-snapshot git leg), because the provider's own rollback explicitly does not touch working-tree changes bash-driven edits leave behind. The daemon-side turn-snapshot service that performs the file restore landed with Plan-010's snapshot phase (campaign bundle B23; shipped 2026-08-09 via PR #303) and remains the durable restoration path regardless of the provider method's fate.

**The successor is `thread/fork` with a turn boundary.** `thread/fork` is present, non-experimental, and gained a new boundary parameter between the floor and this pin — `v2/ThreadForkParams.ts`, absent at `0.141.0`, verbatim:

> Optional last turn id to fork through, inclusive. When specified, turns after `last_turn_id` are omitted from the fork. The referenced turn cannot be in progress.

```
ThreadForkParams.lastTurnId?: string | null    // non-experimental at 0.150.1
```

Two sibling boundary fields on the same type **are** experimental and are not part of this: `beforeTurnId` (`#[experimental("thread/fork.beforeTurnId")]`, "copies history strictly before the referenced turn") and `path`. The README states `lastTurnId` and `beforeTurnId` cannot be combined. A third method, `thread/revert`, exists but is `#[experimental("thread/revert")]` and applies only to paginated threads; its own README entry repeats the file caveat — "It does not revert local file changes."

**What this reference does and does not settle.** Descriptively: `thread/rollback` carries an upstream deprecation at the pin, and `thread/fork` + `lastTurnId` is a non-experimental successor available there. Prescriptively: **nothing**. This is a non-governance reference file, and the two are not interchangeable methods for one behavior — a fork creates a **new thread**, where the deprecated path retains a single binding and rotates its delivery generation at an in-stream fence. That difference is why migration had to be a spec amendment rather than a re-spelling — and **that amendment has since landed (2026-08-26)**: `Spec-005 §Per-Driver Capability Matrix` and `Spec-004 §Driver-Level Rollback Mechanics` now bind the Codex rewind to `thread/fork` at an inclusive `lastTurnId`, and Plan-004's binding-lineage rule is re-derived so both V1 drivers fork-and-supersede. The governing statement lives in those documents, not here; this file continues to record only the wire facts above, and a reader must not take the deprecated method as still-required on the strength of this reference. The file-restore leg is unaffected either way — it was never the provider's.

### `thread/goal/*` — session goals

```
ThreadGoalSetParams = { threadId: string, objective?: string | null, status?: ThreadGoalStatus | null, tokenBudget?: number | null }
```

Set / clear / get are native (`thread/goal/set`, `thread/goal/clear`, `thread/goal/get`); the wire also emits `thread/goal/updated` and `thread/goal/cleared` server notifications. All present at `0.150.1`.

### `thread/inject_items` — item injection

```
ThreadInjectItemsParams = { threadId: string, items: Array<JsonValue> }   // "Raw Responses API items to append to the thread's model-visible history."
```

### `turn/start` — per-turn overrides

Codex accepts per-turn overrides where several Claude equivalents are per-session. The default-generated `v2/TurnStartParams.ts` is **byte-identical at `0.141.0`, `0.149.1` and `0.150.1`** — a stability fact worth having, and one this pin extends rather than restates: `threadId`, `clientUserMessageId`, `input`, and the optional-nullable overrides `cwd`, `approvalPolicy`, `approvalsReviewer`, `sandboxPolicy`, `model`, `serviceTier`, `effort`, `summary`, `personality`, `outputSchema` (a JSON Schema constraining the final assistant message — the structured-output surface).

The posture caveat from the floor still holds and is now stated on the method's own README entry at `rust-v0.150.1`, verbatim: "Prefer experimental `permissions` profile selection by id for permission overrides; the legacy `sandboxPolicy` field is still accepted but cannot be combined with `permissions`."

**Read that together with the generated shape, because they say different things.** The preferred field, `permissions`, is **not present in the default-generated `TurnStartParams` at all** — it appears only under `--experimental`, where its own doc comment reads: "Select a named permissions profile id for this turn and subsequent turns. Cannot be combined with `sandboxPolicy`." This is **field-level** gating on a method that is not itself experimental: `TurnStartParams` is one of the 30 types deriving `ExperimentalApi`, so the method stays in the default surface while individual fields are stripped from it. So at the pin the only per-turn posture override a default connection can send is the one the vendor calls legacy — and the two are mutually exclusive, so a caller does not get to derive both. Posture realization should still prefer named permission profiles where it can opt in, and must treat `sandboxPolicy` as the live compatibility path rather than a removed one. `permissionProfile/list` is labelled **beta** in the same README.

The presence of `approvalsReviewer` here is why the driver pins it explicitly (see below).

#### Command-shaped input is delivered verbatim on this transport

**The `app-server` performs no client-side command parsing of `turn/start` input** (added 2026-08-29; **Binary probe**, **Verified** at `0.150.1` by driving `codex app-server --listen stdio://` through `initialize` → `initialized` → `thread/start` → `turn/start` on a default, non-experimental connection). A first `input` element whose text begins with `/` is echoed back **byte-identical** — leading `/` intact — as a `userMessage` `ThreadItem`, and a real turn is dispatched on it (`turn/started`, then the `item/started` + `item/completed` pair, then `turn/completed`).

This is worth measuring per transport rather than assuming per vendor: the other pinned provider does the opposite on its own programmatic input surface, intercepting the same text client-side so it never reaches the model — see [the Claude reference](claude.md#client-side-command-interception-on-the-programmatic-input-surface).

**The isolation probe is what makes this decisive.** A nonexistent name (`/zzqnotarealcommand …`) would prove only that the app-server does not recognize that particular string. The probe therefore also sent `/status` — a **real** command of this CLI's interactive frontend — and the app-server echoed it verbatim as a `userMessage` and started a turn on it too. The absence of interception is therefore a property of this transport, not an artifact of picking an unknown name.

**Turn-evidence discriminants**, for a consumer that must decide whether input reached the model — all typed fields of the generated protocol, never message prose:

- `ThreadItem` discriminates the participant echo from model output by its own `type` tag: `userMessage` is the echo of what was sent, `agentMessage` is model output. The union carries 18 variants at this pin.
- `TurnStatus` is `completed | interrupted | failed | inProgress`, delivered on `turn/completed` — the only terminal-turn notification in the 79-arm `ServerNotification` root (there is no `turn/failed` and no `turn/interrupted`).
- A failed turn carries a typed `TurnError { message, codexErrorInfo?, additionalDetails? }`, and `CodexErrorInfo` is itself a typed enum: `contextWindowExceeded`, `sessionBudgetExceeded`, `usageLimitExceeded`, `serverOverloaded`, `cyberPolicy`, `misalignmentPolicyViolation`, `internalServerError`, `unauthorized`, `badRequest`, `threadRollbackFailed`, `sandboxError`, `other`, plus object-shaped arms. So "the turn failed" is readable without parsing prose, and is distinguishable from "the turn produced nothing".

**What this probe did not establish — recorded rather than papered over.** Neither turn reached the model: the probing account's quota was exhausted, so each settled `failed` carrying `codexErrorInfo: "usageLimitExceeded"` and a dated reset. What is **Verified** is everything upstream of the model call — that the app-server accepts command-shaped text, echoes it verbatim as the participant item, and dispatches a turn on it. That the **model** then receives those bytes unaltered is **Documented**, not Verified, on this transport: it follows from the echoed item being the model-visible history entry, but no probe here observed a model reply to command-shaped input. Two attempts were made; the block is environmental (a dated quota reset), not a protocol property. The pre-existing verbatim-delivery evidence for this provider is from `codex exec`, a **different frontend** — which is precisely why this transport was probed separately.

**Two notification methods reached a default connection in the same pass and are worth a consumer's attention:** `remoteControl/status/changed` and `thread/status/changed`, both delivered with `capabilities.experimentalApi = false`. They arrived on every run, framing turn dispatch on both sides. A driver whose inbound-method census was transcribed from a narrower reading of the roots routes both to its unknown-method path.

**One connection-scoped frame arrives beside the turn-scoped one.** A top-level `{"method":"error"}` notification carried the same `message` + `codexErrorInfo` payload that `turn/completed`'s `turn.error` then carried. Both were observed in the same pass, so a consumer must not treat the top-level `error` as the turn's only failure signal, nor as a duplicate it may drop before the turn settles.

### `turn/steer` — steering

`turn/steer` is a first-class, non-experimental method at `0.150.1` (the steer capability is graduated always-on, its feature flag removed) — unchanged from the floor.

### `model/list` — the model catalog and the per-model effort vocabulary

Added 2026-08-31. **Generated schema**, **Verified** at `0.150.1` from the generation dated in [Version pin](#version-pin). Both types below are byte-identical in the default and `--experimental` generations, so nothing here is field-gated the way `TurnStartParams.permissions` is.

```
ModelListParams   = { cursor?: string | null, limit?: number | null, includeHidden?: boolean | null }
ModelListResponse = { data: Array<Model>, nextCursor: string | null }
```

**`nextCursor` is required and nullable — not optional. The distinction is load-bearing and the two generated artifacts disagree about it**, so this section transcribes the TypeScript, which is the notation [Capability shapes](#capability-shapes) declares this file follows. `v2/ModelListResponse.ts` emits `nextCursor: string | null` with no `?`: the member is **always present**, carrying `null` to mean "no more pages". The JSON Schema for the same type lists only `data` in `required`, because its `required` describes what a decoder must tolerate missing, while the ts-rs binding describes what the server actually emits. Where the two differ in this section, the TypeScript is quoted and the difference is called out. A consumer that types this member optional will not be wrong at runtime, but a consumer that treats an **absent** `nextCursor` as equivalent to a **null** one is relying on the looser artifact.
**This read is paginated and must be driven as such.** The generated comments are verbatim: `cursor` is "Opaque pagination cursor returned by a previous call."; `nextCursor` is "Opaque cursor to pass to the next call to continue after the last item. If None, there are no more items to return."; `limit` is "Optional page size; defaults to a reasonable server-side value." A consumer that reads `data` and ignores `nextCursor` silently truncates the catalog at whatever the server's default page size happens to be. Contrast [`skills/*`](#skills--the-skill-surface) below, which carries no pagination member at all — the two sibling reads on this surface do not share a convention, so neither one's handling can be inferred from the other.

**Every `Model` field is emitted — none is optional in the binding.** `v2/Model.ts` carries eighteen members and not one of them takes a `?`: `id`, `model`, `upgrade`, `upgradeInfo`, `availabilityNux`, `displayName`, `description`, `modelSpecialty`, `hidden`, `supportedReasoningEfforts`, `defaultReasoningEffort`, `inputModalities`, `supportsPersonality`, `multiAgentVersion`, `additionalSpeedTiers`, `serviceTiers`, `defaultServiceTier`, and `isDefault`. Six of them are **required-and-nullable** rather than optional — `upgrade`, `upgradeInfo`, `availabilityNux`, `modelSpecialty`, `multiAgentVersion`, `defaultServiceTier` — so absence is expressed as `null` on a present key, never as a missing key. (The JSON Schema for the same type names only eight in `required`, listing the rest as optional-with-defaults; that is the same artifact divergence recorded above, and the emitted shape is the TypeScript one.) Note that `id` and `model` are **both** present and **both** required, as separate strings; a consumer keying on one is not keying on the other. `includeHidden` exists because the catalog carries rows the default picker suppresses — its comment reads "When true, include models that are hidden from the default picker list."

**The effort vocabulary is per-model, and the generated schema itself declines to close it.** This is the structural fact, and it is load-bearing in a way no list of values is:

```
supportedReasoningEfforts: ReasoningEffortOption[]
ReasoningEffortOption = { reasoningEffort: ReasoningEffort, description: string }   // both required
ReasoningEffort       = { "type": "string", "minLength": 1 }                        // a constrained string, NOT an enum
```

`ReasoningEffort` carries its own verbatim description — "A non-empty reasoning effort value advertised by the model." The generator emits a **non-empty string**, not a closed union, so the wire's own position is that the set of efforts is whatever each model advertises. No provider-wide effort list can be correct by construction, and a consumer that hardcodes one is asserting something the schema explicitly refuses to. `turn/start`'s `effort` override consumes this same type ("Override the reasoning effort for this turn and subsequent turns."), so the per-turn override is bounded by the per-model catalog rather than by any fixed vocabulary.

**The values at this pin.** **Binary probe**, **Verified**, measured 2026-08-30 by one zero-turn `model/list` after `initialize` / `initialized` on a default connection (`nextCursor: null`; `hidden: false` on every row). `0.150.1` publishes **three distinct effort lists across eight models**, with **no `minimal` on any of them**:

| Effort list | Models |
| --- | --- |
| `low \| medium \| high \| xhigh \| max \| ultra` | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-daybreak-blue-latest` |
| `low \| medium \| high \| xhigh \| max` | `gpt-5.6-luna` — the one row carrying `max` without `ultra` |
| `low \| medium \| high \| xhigh` | `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark` |

That reading is **carried here, not reproduced by this pass**: it is the measurement recorded in [Spec-005 §Provider Parameter Vocabularies](../../specs/005-provider-driver-contract-and-capabilities.md#provider-parameter-vocabularies), and mirrored as the shipped golden vector `packages/runtime-daemon/src/provider/drivers/codex/capabilities.ts#CODEX_DECLARED_MODEL_CATALOG` (**Cross-reference**). Both halves of the pre-2026-08-30 reading this project carried — a single provider-wide list, and `minimal` as its floor value — are contradicted by the pin.

**The three lists *are* strictly nested, and a longest-list union is still wrong** (corrected at PR review 2026-08-31; the first version of this section claimed they were not nested, which is false — `low | medium | high | xhigh` is a prefix of `low | medium | high | xhigh | max`, which is a prefix of `low | medium | high | xhigh | max | ultra`, a totally ordered chain). Nesting makes the union well-defined; it does not make it correct, and the reason is **membership, not shape**. Collapsing to the longest list would offer `ultra` on `gpt-5.6-luna` and both `max` and `ultra` on the four base-list models — efforts those models do not advertise. The wire's own position is per-model, so the only faithful consumption is per-model: carry each model's published list verbatim and offer nothing outside it.

**Across the floor span this type grew too, and one growth is a union widening rather than a plain field add** (measured 2026-08-31 against the `rust-v0.141.0` protocol schemas). `ModelListParams` is byte-identical at `0.141.0` and `0.150.1`, and `model/list` exists at the floor, so the read itself is unchanged. `ModelListResponse` is not: `Model` gained the optional `modelSpecialty` and `multiAgentVersion`, `ModelUpgradeInfo` gained the optional `retirementAt`, the `MultiAgentVersion` definition is new — all additive — **but `InputModality` gained a third variant, `audio`, beside `text` and `image`.** That last one is the same class as the `ReviewDecision` row in [Breaking type changes across the floor](#breaking-type-changes-across-the-floor): a floor-era exhaustive match over `InputModality` does not cover the pin. It carries its own row in that table, with the direction called out there — `InputModality` arrives **from** the provider, so the failure is a decode or match failure on receipt rather than a rejected request.

A sibling read, `modelProvider/capabilities/read`, takes empty params and answers `{ imageGeneration: boolean, namespaceTools: boolean, webSearch: boolean }` (all required). It is a provider-wide feature triple and carries no speed, effort, or model axis.

### Output speed — a method-level negative beside a service-tier surface

Added 2026-08-31; **materially corrected at PR review the same day.** The first version of this section asserted a blanket negative — that Codex publishes no output-speed axis at all — and that claim was too strong. The census behind it was sound; the inference drawn from it was not. What follows separates the two.

**What was measured, and still holds: there is no output-speed axis in the METHOD namespace.** Across all four default union roots — **185 method strings** — **zero** method names match `speed`, `fast`, `turbo`, or `accel`. No method starts, stops, or sets such an axis and no notification reports one. That census is exhaustive over the method roots and is unchanged. **Generated schema**, **Verified** at `0.150.1`.

**What the first version got wrong: the wire does publish a service-tier surface, on the default connection, and it is participant-settable.** Verbatim from the `0.150.1` **default (non-experimental)** generation:

| Member | Generated file | Exact emitted shape | Gating |
| --- | --- | --- | --- |
| `serviceTier` | `v2/TurnStartParams.ts` | `serviceTier?: string \| null \| null` | **present in the DEFAULT generation** — not field-gated |
| `serviceTiers` | `v2/Model.ts` | `serviceTiers: Array<ModelServiceTier>` — required | default |
| `defaultServiceTier` | `v2/Model.ts` | `defaultServiceTier: string \| null` — required, nullable | default |
| `additionalSpeedTiers` | `v2/Model.ts` | `additionalSpeedTiers: Array<string>` — required; "Deprecated: use `serviceTiers` instead." | default |
| `ModelServiceTier` | `v2/ModelServiceTier.ts` | `{ id: string, name: string, description: string }` — all required | default |

Two details from that table matter. `serviceTier` is on `turn/start` in the **default** generation — it is emphatically **not** field-gated the way `permissions` is, so a default connection can set it. And its doubled `| null | null` is the ts-rs rendering of a nested option, which the upstream README confirms is meaningful: "`serviceTier: null` clears the tier" — absent, explicit-null, and a value are three distinct requests.

**The tier values are not in the schema, and the schema is the wrong artifact to ask.** `ModelServiceTier` is three free-form strings; which tiers exist, and what they mean, is runtime catalog data returned by `model/list`. So "does Codex publish a fast tier?" is unanswerable from the generation — which is precisely why the first version's negative overreached: it read a method census as though it settled a field-and-values question.

**Upstream source carries a speed-differentiated tier — in test fixtures.** Two files construct a `ModelServiceTier` literally as:

```
ModelServiceTier { id: "priority", name: "Fast", description: "1.5x speed, increased usage" }
```

found in `codex-rs/core/src/tools/handlers/multi_agents_spec_tests.rs` and `codex-rs/core/tests/suite/spawn_agent_description.rs`. **Grade: Upstream source, Derived — deliberately not Verified, and the limits are the point.** These are test fixtures, not a catalog read. They establish that the vendor models a service tier whose own description is an output-rate claim; they do **not** establish that any production catalog publishes that tier, at this pin or any other. Two further limits are stated rather than glossed: the fixtures were read at the **floor** tag `rust-v0.141.0`, because the pinned-tag source subset held locally covers `app-server` and `app-server-protocol` only and does not include `core/`; and this pass ran no live `model/list` capture that retained `serviceTiers` values, so the tier set an authenticated `0.150.1` catalog actually returns is **not established here**. A live capture retaining that array is the probe that would settle it.

**Recorded divergence, for adjudication in the governing spec rather than here.** [Spec-005](../../specs/005-provider-driver-contract-and-capabilities.md) and the shipped Codex capability table declare `output_speed: false` for this driver — `packages/runtime-daemon/src/provider/driver-output-speed.ts#DRIVER_OUTPUT_SPEED_LEVELS` maps `codex` to the empty level list, and `packages/runtime-daemon/src/provider/capability-probe.ts#CODEX_CAPABILITY_DETECTION_TABLE` records the axis as `detectionSource: "static"` (**Cross-reference**). This is a non-governance reference file and has no standing to change that, so it does not. What it records is the wire fact and the open question. The wire fact: a participant-settable per-turn `serviceTier` override exists on the default surface, model rows publish a tier list and a catalog default, and the vendor's own fixture describes one tier as "1.5x speed, increased usage". The open question: whether that constitutes the **declared fast-output-state** concept the corpus means by `output_speed`. The two are not obviously the same shape — the corpus axis is a *declared current state* plus a *published settable level vocabulary*, which is how the Claude leg is built, whereas `serviceTier` is a per-turn routing override with no current-state read and no enumerated level set anywhere on this wire. Both readings are defensible, and choosing between them is a governing-spec decision. **Flagged here as a divergence; not resolved here.**

**The other two `speed`-token occurrences are genuinely unrelated**, and are listed so a reader greping the generation can rule them out rather than mistake them for the surface above:

| Where | Emitted shape | What it actually is |
| --- | --- | --- |
| `ThreadUsageBreakdownGroup.speed` | `string \| null` | A usage-**attribution** grouping key, beside `model` and `reasoningEffort` on the `account/usage/read` response (the arm carrying `GetAccountTokenUsageParams`; there is no bare `getAccountTokenUsage` method). It reports; it does not set. |
| `ModelSafetyBufferingUpdatedNotification.fasterModel` | `string \| null` | Names an alternative model on a safety-buffering notification. A model identity, not a speed setting. |

**Scope note.** The method-level census is exhaustive over the four default roots and nothing more. It never was a claim that the token `speed` appears nowhere in the generation, and it cannot carry a claim about field-level surfaces or catalog values — which is exactly the widening that produced the original error.

### `skills/*` — the skill surface

Added 2026-08-31. **Generated schema**, **Verified** at `0.150.1`. Every shape in this section is **byte-identical in the default and `--experimental` generations**, so — unlike `TurnStartParams.permissions` — nothing in this family is field-gated, and presence in the default `ClientRequest` root does mean callable on a default connection.

**This family is the one exception to the [Capability shapes](#capability-shapes) preamble's byte-identical-across-the-pin-hop claim, and the difference is additive.** Measured file by file against the `0.149.1` generation: `SkillsListParams`, `SkillsChangedNotification`, `SkillsConfigWriteParams` / `…Response`, `SkillsExtraRootsSetParams` / `…Response`, and `PluginSkillReadParams` / `…Response` are all byte-identical across the hop, but `SkillsListResponse` is **not** — its nested `SkillMetadata` gained one field at `0.150.1`, `pluginId`, whose verbatim comment is "Owning plugin ID, matching `PluginSummary.id`, when known." No definition was added or removed. The new member is **required-and-nullable in the emitted binding**, so the emitted member set grew from eight to nine and a `0.150.1` reply carries a key a `0.149.1`-era consumer has never seen — harmless to any decoder that ignores unknown members, which is the ordinary case, and not a `required`-set move in the JSON Schema's looser sense, where the field is listed optional. Note that the axes are independent and each was measured separately: default-versus-`--experimental` at `0.150.1` (identical for every type here) is a different question from `0.149.1`-versus-`0.150.1` (identical for every type here **but** `SkillsListResponse`).

**Across the full floor span the same family is additive-only** (measured 2026-08-31 against the `rust-v0.141.0` protocol schemas, whose four union roots carry the 85 / 66 / 10 / 1 arms [recorded for the floor](#version-pin)). All five method strings above already exist at `0.141.0`, `skills/changed` included, so nothing in this family was introduced across the span. Two shapes grew, both by optional fields only, with no definition and no required field added or removed: `SkillMetadata` gained `pluginId`, and `SkillInterface` gained `iconLargeUrl` and `iconSmallUrl`. A floor-era consumer therefore still decodes a pin-era reply — it simply sees fewer fields.

Four client requests and one server notification, all present in the default roots:

| Method | Direction | Gated |
| --- | --- | --- |
| `skills/list` | client → server | no |
| `skills/config/write` | client → server | no |
| `skills/extraRoots/set` | client → server | no |
| `plugin/skill/read` | client → server | no |
| `skills/changed` | server → client (notification) | **no** — it carries no `#[experimental(…)]` marker and is not among the 23 enumerated under [The experimental gate](#the-experimental-gate--a-runtime-filter-not-a-schema-filter), so a default connection does receive it |

That last row is worth stating rather than assuming, because [the realtime family](#threadrealtime--realtime-voice-gated) is the cautionary case in the other direction: eleven notifications present in the default schema and delivered to nobody. `skills/changed` is the opposite outcome — present **and** delivered — and the two can only be told apart by reading the markers, never the schema.

**`skills/list` — the read.**

```
SkillsListParams   = { cwds?: Array<string>, forceReload?: boolean }                       // optional, NOT nullable
SkillsListResponse = { data: Array<SkillsListEntry> }                                     // required
SkillsListEntry    = { cwd: string, skills: Array<SkillMetadata>, errors: Array<SkillErrorInfo> }  // all three required
SkillErrorInfo     = { path: string, message: string }                                    // both required
```

Verbatim comments: `cwds` — "When empty, defaults to the current session working directory."; `forceReload` — "When true, bypass the skills cache and re-scan skills from disk."

**The reply is grouped per scanned working directory, not flat.** There is one `SkillsListEntry` per `cwd`, each carrying its own `skills` and its own `errors` — so a consumer wanting a single list concatenates the groups, and a per-directory scan failure surfaces as a populated `errors` array on that one group rather than as a request-level refusal. A partially-failed scan is therefore a **success** on this wire.

**There is no pagination on either side of this read** — no `cursor`, no `limit`, no `nextCursor` anywhere in the params or the response. The whole set arrives in one reply. That is the opposite convention from [`model/list`](#modellist--the-model-catalog-and-the-per-model-effort-vocabulary) above, and the difference is real rather than an omission in this reference.

**`SkillMetadata` — the entry shape.**

```
SkillMetadata = {
  name: string, description: string,
  shortDescription?: string, interface?: SkillInterface, dependencies?: SkillDependencies,
  path: AbsolutePathBuf, scope: SkillScope, enabled: boolean,
  pluginId: string | null                                    // ← required AND nullable, not optional
}
SkillScope = "user" | "repo" | "system" | "admin"
```

**Six members are emitted unconditionally and three may be absent.** `pluginId` is **required-and-nullable** — always present, carrying `null` where the owning plugin is unknown — while `shortDescription`, `interface`, and `dependencies` are genuinely optional and, in the TypeScript binding, **not** nullable: they are absent or they carry a value. (The JSON Schema types all four as nullable and names only five members in `required`; the emitted shape is the TypeScript one, per the artifact divergence recorded under [`model/list`](#modellist--the-model-catalog-and-the-per-model-effort-vocabulary).)

Three consequences of that required-set that a normalizing consumer depends on:

- **`description` is required.** What the generated shape establishes is a decoding rule and nothing more: `description` is present on every entry the reply returns, so a consumer must accept it and has no absent case to handle here. It does **not** establish what the provider does with a skill whose source file declares no description — an empty string on a returned row and no row at all plus a `SkillErrorInfo` in that group's `errors` array are both consistent with this schema, and this pass ran no runtime probe that separates them. PR review reports the second (a missing or invalid `description` yields an `errors` entry and no skill row); recorded as **reviewer-reported, Provisional**, since a schema cannot settle a runtime behavior and no probe was run to settle it here.
- **`scope` is required**, drawn from the closed four-value set above. This surface always declares a scope. The Claude handshake enumeration declares none at all, which is why a cross-provider normalized entry has to type the field optional even though Codex never omits it.
- **`enabled` is required, and disabled skills are returned rather than filtered.** The reply is the full scanned set carrying a flag, not a pre-filtered list of active skills — so a consumer that wants only active skills filters client-side, and a consumer that counts entries is not counting available ones.

`AbsolutePathBuf` carries its own verbatim description — "A path that is guaranteed to be absolute and normalized (though it is not guaranteed to be canonicalized or exist on the filesystem)." — so a `path` here is absolute but is **not** evidence the file exists.

**`skills/changed` — the invalidation signal.** The notification type is an **empty object** carrying no payload whatsoever, and its entire generated description is verbatim:

> Notification emitted when watched local skill files change.
>
> Treat this as an invalidation signal and re-run `skills/list` with the client's current parameters when refreshed skill metadata is needed.

The wire therefore specifies its own refresh discipline: there is no delta, no changed-entry list, and no means of patching a held list. The only correct response is a **full re-read** with the same parameters the consumer used originally. A consumer holding skill state discards it wholesale on this frame.

**The mutating siblings**, recorded for completeness — this project reads this family and does not currently drive these:

```
SkillsConfigWriteParams     = { path?: AbsolutePathBuf | null, name?: string | null, enabled: boolean }
SkillsConfigWriteResponse   = { effectiveEnabled: boolean }
SkillsExtraRootsSetParams   = { extraRoots: Array<AbsolutePathBuf> }
SkillsExtraRootsSetResponse = {}                                                  // empty object
PluginSkillReadParams       = { remoteMarketplaceName: string, remotePluginId: string, skillName: string }   // all required
PluginSkillReadResponse     = { contents: string | null }                         // required AND nullable
```

`skills/config/write` takes **either** a name-based **or** a path-based selector — two separately-nullable fields whose verbatim comments are "Name-based selector." and "Path-based selector." — and answers with the resolved `effectiveEnabled` rather than echoing the request, so the write's outcome is read from the reply rather than assumed from the request.

### Server-requests — the callback / interactive / approval surface (Codex → daemon)

`ServerRequest` carries 10 methods at `0.150.1` — **the same 10 as at `0.141.0`**, the one root that has not moved anywhere across the floor. This is the surface the daemon answers back on:

- Callback tools: `item/tool/call`; interactive input: `item/tool/requestUserInput` (**EXPERIMENTAL** — the generated definition is marked "EXPERIMENTAL - Request input from the user for a tool call.", and experimental surfaces require `initialize.capabilities.experimentalApi = true`; a default app-server session never delivers this method, so the Plan-005 interactive-request leg must opt in at `initialize`), `mcpServer/elicitation/request`.
- Approvals (modern): `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`; (legacy) `execCommandApproval`, `applyPatchApproval`.
- Also `attestation/generate`, `account/chatgptAuthTokens/refresh`.

Every approval server-request routes through the daemon's own approval pipeline. The approval reviewer defaults to `user` in the generated schema; the driver pins `approvalsReviewer: "user"` as defense-in-depth so a config or profile override cannot select an auto-review path that would bypass that pipeline.

### `thread/realtime/*` — realtime voice (gated)

The realtime family is **gated on both directions of the wire at `0.150.1`**, and the two directions are gated by different mechanisms — which is why the generated schema on its own reads misleadingly here. This is also the family that grew at this pin: it carries **three more server notifications than at `0.149.1`, and no fewer**.

- **The six client request methods** — `thread/realtime/start` / `appendAudio` / `appendText` / `appendSpeech` / `stop` / `listVoices` — are **absent from the default-generated `ClientRequest`**, unchanged in membership from `0.149.1`. All six are registered `#[experimental(…)]` in the pinned protocol source (`codex-rs/app-server-protocol/src/protocol/common.rs` at `rust-v0.150.1`), so their bindings require experimental generation. `listVoices` is protocol-registered but still absent from the upstream README's documented set at this pin; the other five are each marked "(experimental)" there.
- **The eleven server notifications** — `thread/realtime/started`, `…/closed`, `…/error`, `…/itemAdded`, `…/sdp`, `…/outputAudio/delta`, `…/transcript/delta`, `…/transcript/done`, and, new at `0.150.1`, `…/item/started`, `…/item/transcript/delta`, `…/item/completed` (a WebRTC-shaped surface) — **do appear in the default-generated `ServerNotification` schema**, and a driver reading only that schema would conclude they arrive. **They do not.** All eleven carry `#[experimental(…)]` markers in the same protocol source, and the transport's `should_skip_notification_for_connection` drops every experimental notification for a connection that did not set `experimentalApi` (see [The experimental gate](#the-experimental-gate--a-runtime-filter-not-a-schema-filter)). They are in the schema by construction — the generator has no notification-side experimental exclusion — and off the wire at runtime.
- **The three new names are additions, not renames — measured, because it reads like a rename.** `thread/realtime/item/started` / `…/item/transcript/delta` / `…/item/completed` are item-scoped spellings of surfaces the family already had, so the obvious reading is that they replaced `…/itemAdded` / `…/transcript/delta` / `…/transcript/done`. A full-list-vs-full-list set difference between the two default generations says otherwise: **four arms added, zero removed**, and all three older names are still in the `0.150.1` root. A consumer that treats this as a rename and drops the old spellings will stop recognizing frames the pin still publishes. What is not settled here is which spelling the upstream feature will keep — the family is Provisional either way.

**Trust: Provisional.** The upstream realtime feature is under active development and gated OFF by default in both directions — the +3 at this pin is evidence of exactly that motion. Notification types being present at the pin does not make the capability available. No emulation is claimed on this leg.

### Adjacent currency facts (Verified from the same generation)

- `account/rateLimits/read` (pull) + `account/rateLimits/updated` (push) — rate limits are first-class. The pull's README entry at this pin also names an optional effective monthly credit limit, a spend-control-reached flag, and earned rate-limit resets; reset-credit data is snapshot-only.
- `account/read` — "fetch current account info; optionally refresh tokens" (README, verbatim). Its params carry `refreshToken: bool`, whose generated doc comment reads: "When `true`, requests a proactive token refresh before returning. In managed auth mode this triggers the normal refresh-token flow. In external auth mode this flag is ignored." **The refresh outcome is not surfaced** — a permanently-dead refresh token does not fail this RPC, so `account/read` succeeding is not evidence that credentials are usable. This is the method the nightly compatibility check uses as its authless liveness probe precisely because it answers without credentials.
- The `account/*` family grew across the floor: `account/usage/read`, `account/workspaceMessages/read`, `account/rateLimitResetCredit/consume`, `account/sendAddCreditsNudgeEmail`, `account/logout`, `account/login/start`, `account/login/cancel` all present at the pin.
- `thread/compact/start` + `thread/compacted` — compaction is controllable.
- `turn/diff/updated` + `turn/plan/updated` — the per-turn diff and plan snapshot notifications. Both are present in the default-generated `ServerNotification` union and **neither is gated**: neither carries an `#[experimental(…)]` marker, so neither appears in the 19 enumerated under [The experimental gate](#the-experimental-gate--a-runtime-filter-not-a-schema-filter), and a default connection receives both. **Mind the suffix** — these two carry `/updated`; their sibling `turn/moderationMetadata`, which *is* gated, does not. The truncated spellings `turn/diff` / `turn/plan` name nothing in the 79-arm root, so a consumer that transcribes the family from prose rather than from the generation routes two live frames to its unknown-method path (added 2026-08-28; **Generated schema**, **Verified** at `0.150.1` from a re-run of [Regeneration](#regeneration) against this pin, and unchanged from `0.149.1`).
- `config/batchWrite`, `config/value/write`, `config/mcpServer/reload` — a wire-first config-write surface (the modern path for MCP-server config edits). `config/batchWrite` applies edits atomically with optional `reloadUserConfig: true`.
- `permissionProfile/list` — named sandbox/permission profiles; **beta** per the pinned README.
- **The in-band version channel is `initialize`'s `userAgent`, and it is composite** (added 2026-08-26; **Binary probe**, **Verified** at `0.149.1`, re-verified at `0.150.1`). The `initialize` result carries `userAgent`, `codexHome`, `platformFamily`, and `platformOs` — no version field of its own. The running `codex-cli` version is inside the `userAgent` string, which at this pin reads `<clientName>/<codexVersion> (<os>; <arch>) <terminal> (<clientName>; <clientVersion>)` — so the **caller's** own name and version also appear in it, and a consumer that adopts the string, or parses the trailing parenthetical, gets its own version back rather than the server's. There is no structured alternative on this transport: `server/diagnostics` refuses a default connection with `-32600 "server/diagnostics requires experimentalApi capability"`, and a connection that does negotiate `experimentalApi` gets process id, memory footprint, and request gauges — still no version. A driver reading the provider version in-band therefore extracts it from `userAgent` under a stated rule, or refuses.
- Guardian routing: `guardianWarning`, `item/autoApprovalReview/started`, `item/autoApprovalReview/completed`, `thread/approveGuardianDeniedAction`.
- Arrived at the previous pin and still worth knowing about: the `threadSection/*` family (`create` / `delete` / `list` / `update`) plus `thread/section/move`, the `externalAgentConfig/import/*` pair, `app/read` + `app/installed`, and the notifications `model/safetyBuffering/updated` and `thread/queue/changed`.
- **New at this pin, and the only non-realtime arm the hop added: `mcpServer/event/stream/notification`.** It joins `mcpServer/oauthLogin/completed` and `mcpServer/startupStatus/updated`, taking the `mcpServer*` notification family from two arms to three, and carries a new generated params type `v2/McpServerEventStreamNotification.ts`. It is **gated** — one of the four markers this hop added — so a default connection does not receive it, and it is counted in the 23 above.

## Breaking type changes across the floor

No method string was removed between `0.141.0` and `0.150.1`, but five shapes changed in ways that break a client written against the floor. All five are **Verified** from the generations, with the exec-path row additionally **Binary probe**. The first four were identified at this pin's authoring and re-measured at it, and none moved between `0.149.1` and `0.150.1` — the three generated types are byte-identical across that hop and the exit-code probe still answers the same way; the `InputModality` row was measured 2026-08-31 against the `rust-v0.141.0` protocol schemas alongside the [`model/list`](#modellist--the-model-catalog-and-the-per-model-effort-vocabulary) section that reproduces the type, and is likewise byte-identical across the `0.149.1` → `0.150.1` hop.

| Change | At `0.141.0` | At `0.150.1` | Consequence |
| --- | --- | --- | --- |
| `AskForApproval` lost a variant | `"untrusted" \| "on-request" \| "on-failure" \| { granular: … } \| "never"` | `"untrusted" \| "on-request" \| { granular: … } \| "never"` | **`"on-failure"` is gone.** Sending it against the pin is an invalid `approvalPolicy`. A driver that stores an approval posture as this literal has a persisted value the pin rejects. |
| `ReviewDecision.denied` changed arity | bare string `"denied"` | `{ "denied": { rejection: string } }` | A denial now carries a required reason payload. Emitting the bare string is a decode failure at the pin. |
| `ReviewDecision` gained variants | — | adds `approved_mcp_policy_amendment` (and retains the `approved_execpolicy_amendment` / `network_policy_amendment` object arms) | A floor-era exhaustive match over the union does not cover the pin. |
| `InputModality` gained a variant | `"text" \| "image"` | adds `"audio"` | A floor-era exhaustive match over the union does not cover the pin. Direction differs from the client-sent rows above: this value arrives **from** the provider on `ModelListResponse`, so the failure is a decode or match failure on receipt, not a rejected request. |
| `codex exec --full-auto` withdrawn | `codex exec --full-auto --help` exits **0** | the same invocation exits **2** with `error: unexpected argument '--full-auto' found` (re-probed at `0.150.1`) | An `exec`-path invocation built at the floor fails at the pin as a CLI-parse error, not as a protocol error — so it surfaces as a spawn failure rather than a typed refusal unless the driver classifies exit-2-with-`unexpected argument`. |

These are exactly the class the [family README](README.md#versioning-and-pinning-policy)'s degrade-per-capability rule exists for: none of them is a reason to refuse a session, and each one is a reason to refuse or emulate one capability.

## Driver fixtures

Captured-wire fixtures for the Codex event-normalizer are cited as text (they do not exist yet): `packages/runtime-daemon/src/provider/drivers/codex/__fixtures__/` — lands with Plan-005 Phase 3.

## Provenance

- Generated shapes and every census number above: **Generated schema** provenance, **Verified** trust at `codex-cli 0.150.1`, regenerated 2026-08-28 via the commands in [Regeneration](#regeneration). The set differences quoted against `0.141.0` and `0.149.1` were computed from generations of those exact releases produced in the same pass, each installed from the npm registry and generated into its own scratch `CODEX_HOME` — full list against full list, never a named subset against a full root.
- The experimental-gate mechanism, the `#[experimental(…)]` marker sets, and the realtime client-method registrations: **Upstream source** provenance, **Verified**, read at the release tag `openai/codex` `rust-v0.150.1` (`codex-rs/app-server/src/transport.rs`, `codex-rs/app-server-protocol/src/protocol/common.rs`); the 19-versus-23 comparison was taken by reading `rust-v0.149.1` the same way.
- Verbatim README quotations (`thread/rollback` deprecation, `turn/start` posture preference, `thread/fork` boundary rules, `account/*` entries): **Official docs** provenance at the same tag (`codex-rs/app-server/README.md`), **Verified** as quoted.
- The `--full-auto` withdrawal row: **Binary probe**, **Verified** — exit-code probe of the floor and the pin.
- [Refusal shapes on the client-request channel](#refusal-shapes-on-the-client-request-channel): **Binary probe** provenance, **Verified** at `0.150.1`, measured 2026-08-30 against a default (non-`experimentalApi`) connection. Every message is quoted as emitted; only the probed name is substituted. The nested-variant row was drawn by sending the withdrawn `AskForApproval` arm on an otherwise well-formed request. Credential posture was read-only: no `account/login/*` or `account/logout` method was sent and `~/.codex/auth.json` was unmodified across the pass.
- [Command-shaped input is delivered verbatim on this transport](#command-shaped-input-is-delivered-verbatim-on-this-transport): **Binary probe** provenance, **Verified** at `0.150.1` for everything upstream of the model call, measured 2026-08-29 by a purpose-written stdio client driving the pinned binary's `app-server` through a full `initialize` → `initialized` → `thread/start` → `turn/start` sequence on a default connection, recording every inbound frame until the turn settled. Two prompts were sent: an unknown command name and the real `/status`. The section marks its own model-receipt leg **Documented**, not Verified, and names the environmental reason. Credential posture was read-only throughout: no `account/login/*` or `account/logout` method was sent, no auth verb was invoked, and `~/.codex/auth.json` was unmodified across the pass.
- [`model/list` — the model catalog and the per-model effort vocabulary](#modellist--the-model-catalog-and-the-per-model-effort-vocabulary), [Output speed — a method-level negative beside a service-tier surface](#output-speed--a-method-level-negative-beside-a-service-tier-surface), and [`skills/*` — the skill surface](#skills--the-skill-surface) (all added 2026-08-31): **Generated schema** provenance, **Verified** at `0.150.1`, read from the same 2026-08-28 generation the rest of this file is pinned to — nothing was regenerated for these sections, and the [Version pin](#version-pin) `Regenerated` date is unchanged. **Two independent identity axes were each checked shape by shape rather than assumed.** Default-versus-`--experimental` at `0.150.1`: `SkillsListParams`, `SkillsListResponse`, `SkillsChangedNotification`, `SkillsConfigWriteParams`, `SkillsExtraRootsSetParams`, `PluginSkillReadParams`, `ModelListParams`, and `ModelListResponse` are byte-identical, so no member of either family is field-gated. `0.149.1`-versus-`0.150.1`: the same set is byte-identical **except** `SkillsListResponse`, whose nested `SkillMetadata` gained the required-and-nullable `pluginId` — which is why this pass narrowed the [Capability shapes](#capability-shapes) preamble's blanket identity claim instead of extending it over the new sections. A third axis, the **full floor span**, was measured against the `rust-v0.141.0` protocol schemas (verified as the floor by their 85 / 66 / 10 / 1 union-root arm counts): every method string in both families already exists at `0.141.0`, and the only shape changes are additive optional fields plus one union widening — `InputModality` gaining `audio` — which is recorded both in [`model/list`](#modellist--the-model-catalog-and-the-per-model-effort-vocabulary), where the type is reproduced, and as its own row in the [Breaking type changes](#breaking-type-changes-across-the-floor) table.
- The output-speed section carries **three different grades and says which is which**, after a PR-review correction on 2026-08-31 that narrowed an over-broad negative. The **method-level census** (185 method strings across the four default roots, 0 matching `speed`/`fast`/`turbo`/`accel`, with the field-level positive control run in the same pass so the zero is a measurement rather than a failed search) is **Generated schema**, **Verified** at `0.150.1`, and is scoped to the method roots. The **service-tier surface** — `TurnStartParams.serviceTier` present in the DEFAULT generation, plus `Model.serviceTiers` / `defaultServiceTier` / `additionalSpeedTiers` and the `ModelServiceTier` shape — is likewise **Generated schema**, **Verified** at `0.150.1`, read from the default and `--experimental` TypeScript bindings and confirmed against the `rust-v0.150.1` README's `model/list` entry (**Official docs**). The **`priority` / `Fast` / "1.5x speed, increased usage" tier value** is **Upstream source**, **Derived** — it is a test fixture read at the floor tag `rust-v0.141.0`, not a catalog read, and no live `model/list` capture retaining `serviceTiers` values was taken at this pin, so the production tier set is explicitly not established. The gap between that wire surface and the corpus's `output_speed: false` declaration is recorded in-section as a divergence for governing-spec adjudication; this file resolves nothing.
- The per-model effort **values** (three lists, eight models): **Binary probe**, **Verified**, measured 2026-08-30 by a zero-turn `model/list`, and **carried into this file rather than re-measured by it** — the reading's home is [Spec-005 §Provider Parameter Vocabularies](../../specs/005-provider-driver-contract-and-capabilities.md#provider-parameter-vocabularies), with the shipped `CODEX_DECLARED_MODEL_CATALOG` golden vector as the **Cross-reference** mirror. The per-model *structure* (`ReasoningEffort` being a non-empty string rather than an enum) is **Generated schema** / **Verified** and was read directly from the generation.
- The evidence rules these pins follow (regeneration is canonical over prose docs; re-verify per version) are recorded campaign-wide in the capability-enhancements design §3.4 (`../../superpowers/specs/2026-07-01-capability-enhancements-design.md`).
