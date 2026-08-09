# Codex Wire Reference

Pinned wire reference for the Codex `app-server` JSON-RPC protocol as driven by `codex-driver`. See the [family README](README.md) for the TRUST / PROVENANCE vocabulary this file uses.

## Version pin

| Field | Value |
| --- | --- |
| Pinned version | `codex-cli 0.141.0` (locally installed) |
| Current stable at authoring | `0.142.5` (released 2026-07-01) — a minor ahead |
| Primary anchor | the binary's own **Generated schema** (canonical over prose docs) |
| Regenerated | 2026-07-02 |

**Trust framing (read before citing any shape below).** Every shape in this file is **Generated schema** provenance and **Verified** trust **at `0.141.0`**. Because `0.142.5` is the current stable, each shape is only **Provisional** when read against that newer release — Codex ships a minor every 1–2 weeks plus near-daily alphas, so a consumer re-verifies its load-bearing shapes against the then-installed binary rather than trusting this pin. This is the live orthogonality case from the README: provenance stays `Generated schema`; trust falls from `Verified@0.141.0` to `Provisional` against a newer pin.

## Regeneration

The Codex wire is regenerated from the pinned binary, never hand-transcribed. Both subcommands are `[experimental]` and nested under `app-server` (they are not top-level — verify names against `codex app-server --help` per version):

```
codex app-server generate-json-schema --out <DIR>   # JSON Schema bundle
codex app-server generate-ts          --out <DIR>   # TypeScript bindings (ts-rs)
```

At `0.141.0` this emits a JSON Schema bundle (`ClientRequest.json`, `ServerRequest.json`, `ServerNotification.json`, `ClientNotification.json`, per-type files, plus aggregate `codex_app_server_protocol.schemas.json` / `…v2.schemas.json`) and a parallel TypeScript tree. Both split types into a **legacy top-level set** and a **`v2/` subdirectory** that now holds the modern protocol. `--experimental` adds experimental methods and fields to the output; the shapes pinned here are from the default (non-experimental) generation.

## Method namespace

The wire has two coexisting method-naming styles at `0.141.0` (the shapes below are Verified from `ClientRequest.json` / `ServerRequest.json` / `ServerNotification.json`):

- **Legacy — bare camelCase, no slash.** A small residual set: client requests `initialize`, `fuzzyFileSearch`; server requests `execCommandApproval`, `applyPatchApproval`; the client notification `initialized`; server notifications `error`, `warning`, `configWarning`, `deprecationNotice`, `guardianWarning`.
- **Modern — slash-namespaced paths** (their generated types live under `v2/`). This is where the capability surface this project drives lives: `thread/*`, `turn/*`, `account/*`, `config/*`, `mcpServer*/*`, `permissionProfile/*`, `review/start`. Note the paths are slash-namespaced method strings (e.g. `thread/rollback`); they are **not** prefixed with a literal `v2/` on the wire — the `v2/` is the generated-file layout, not a method-string segment.

`ClientRequest` at `0.141.0` unions 85 client-request methods across both styles.

## Capability shapes

Shapes relevant to the capabilities this project normalizes, pinned from the `0.141.0` generation. Field notation follows the generated TypeScript (`?` = optional, `| null` = nullable).

### `thread/rollback` — session time-travel (conversation leg)

```
ThreadRollbackParams = { threadId: string, numTurns: number }   // numTurns >= 1
```

The generated type carries a load-bearing doc comment, quoted verbatim:

> The number of turns to drop from the end of the thread. Must be >= 1. This only modifies the thread's history and does not revert local file changes that have been made by the agent. Clients are responsible for reverting these changes.

This is the primary-source basis for splitting rollback into two legs: `thread/rollback` reverts the **conversation** only; **file** restoration is the daemon's responsibility (the turn-snapshot git leg), because the provider's own rollback explicitly does not touch working-tree changes bash-driven edits leave behind. The daemon-side turn-snapshot service that performs the file restore landed with Plan-010's snapshot phase (campaign bundle B23; shipped 2026-08-09 via PR #303). **Upstream deprecation notice (verified 2026-07-02):** the pinned `0.141.0` app-server README carries no deprecation on `thread/rollback`, but upstream `main`'s README now reads "`thread/rollback` — deprecated and will be removed soon" — so this method's trust is **Verified at the pin, Provisional beyond it**: the Plan-005/Plan-010 rollback work MUST re-verify the method (or its replacement) against the then-installed binary before driver code lands, and the daemon-side snapshot leg remains the durable restoration path regardless of the provider method's fate.

### `thread/goal/*` — session goals

```
ThreadGoalSetParams = { threadId: string, objective?: string | null, status?: ThreadGoalStatus | null, tokenBudget?: number | null }
```

Set / clear / get are native (`thread/goal/set`, `thread/goal/clear`, `thread/goal/get`); the wire also emits `thread/goal/updated` and `thread/goal/cleared` server notifications.

### `thread/inject_items` — item injection

```
ThreadInjectItemsParams = { threadId: string, items: Array<JsonValue> }   // "Raw Responses API items to append to the thread's model-visible history."
```

### `turn/start` — per-turn overrides

Codex accepts per-turn overrides where several Claude equivalents are per-session. The `TurnStartParams` shape includes (optional, nullable) `approvalPolicy`, `approvalsReviewer`, `sandboxPolicy`, `model`, `serviceTier`, `effort`, `summary`, `personality`, and `outputSchema` (a JSON Schema constraining the final assistant message — the structured-output surface), alongside `threadId` and `input`. A currency caveat from the pinned README: the per-turn `sandboxPolicy` field is described as **legacy** ("still accepted but cannot be combined with `permissions`"; the preferred override is the experimental `permissions` profile-selection-by-id), so posture realization should prefer named permission profiles and treat `sandboxPolicy` as the compatibility path. The presence of `approvalsReviewer` here is why the driver pins it explicitly (see below).

### `turn/steer` — steering

`turn/steer` is a first-class method at `0.141.0` (the steer capability is graduated always-on, its feature flag removed).

### Server-requests — the callback / interactive / approval surface (Codex → daemon)

`ServerRequest` at `0.141.0` carries 10 methods — the surface the daemon answers back on:

- Callback tools: `item/tool/call`; interactive input: `item/tool/requestUserInput` (**EXPERIMENTAL** in the 0.141.0 schema — the generated definition is marked "EXPERIMENTAL - Request input from the user for a tool call.", and experimental surfaces require `initialize.capabilities.experimentalApi = true`; a default app-server session never delivers this method, so the Plan-005 interactive-request leg must opt in at `initialize`), `mcpServer/elicitation/request`.
- Approvals (modern): `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`; (legacy) `execCommandApproval`, `applyPatchApproval`.
- Also `attestation/generate`, `account/chatgptAuthTokens/refresh`.

Every approval server-request routes through the daemon's own approval pipeline. The approval reviewer defaults to `user` in the generated schema; the driver pins `approvalsReviewer: "user"` as defense-in-depth so a config or profile override cannot select an auto-review path that would bypass that pipeline.

### `thread/realtime/*` — realtime voice (gated)

The realtime family's **client-callable methods are experimental-only** at `0.141.0`, while the default (stable-only) generation splits the family: the eight **server notifications** `thread/realtime/started`, `…/closed`, `…/error`, `…/itemAdded`, `…/sdp`, `…/outputAudio/delta`, `…/transcript/delta`, `…/transcript/done` (a WebRTC-shaped surface) DO appear in the default-generated `ServerNotification` schema, while the **six client request methods** (`thread/realtime/start` / `appendAudio` / `appendText` / `appendSpeech` / `stop` / `listVoices` — all six registered `#[experimental(…)]` in the pinned protocol source `codex-rs/app-server-protocol/src/protocol/common.rs`; `listVoices` is protocol-registered but absent from the pinned README's documented set) are absent from the default-generated `ClientRequest` — the pinned README marks each "(experimental)", so their bindings require experimental generation and their use requires the `initialize.capabilities.experimentalApi = true` opt-in. **Trust: Provisional.** The upstream realtime feature is under active development and gated OFF; notification types being present at the pin does not make the capability available. No emulation is claimed on this leg.

### Adjacent currency facts (Verified from the same generation)

- `account/rateLimits/read` (pull) + `account/rateLimits/updated` (push) — rate limits are first-class.
- `thread/compact/start` + `thread/compacted` — compaction is controllable.
- `config/batchWrite`, `config/value/write`, `config/mcpServer/reload` — a wire-first config-write surface (the modern path for MCP-server config edits).
- `permissionProfile/list` — named sandbox/permission profiles.
- Guardian routing: `guardianWarning`, `item/autoApprovalReview/started`, `item/autoApprovalReview/completed`, `thread/approveGuardianDeniedAction`.

## Driver fixtures

Captured-wire fixtures for the Codex event-normalizer are cited as text (they do not exist yet): `packages/runtime-daemon/src/provider/drivers/codex/__fixtures__/` — lands with Plan-005 Phase 3.

## Provenance

- All shapes above: **Generated schema** provenance, **Verified** trust at `codex-cli 0.141.0`, regenerated 2026-07-02 via the commands in [Regeneration](#regeneration). Read against `0.142.5` stable, treat as **Provisional**.
- The evidence rules these pins follow (regeneration is canonical over prose docs; re-verify per version) are recorded campaign-wide in the capability-enhancements design §3.4 (`../../superpowers/specs/2026-07-01-capability-enhancements-design.md`).
