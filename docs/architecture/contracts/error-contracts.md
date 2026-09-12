# Error Contracts

Canonical error shapes, error code namespaces, and standard error responses for the AI Sidekicks platform.

See also [API Payload Contracts](./api-payload-contracts.md) for the base `ErrorResponse` and `RateLimitResponse` types.

---

## Error Response Shape

All API errors use the canonical `ErrorResponse` envelope defined in API Payload Contracts:

```ts
interface ErrorResponse {
  code: string; // namespaced: 'session.not_found', 'auth.token_expired', etc.
  message: string; // human-readable description
  details?: Record<string, unknown>; // structured context
}
```

This shape is the **HTTP/control-plane** envelope (tRPC + REST surfaces). Local IPC traffic uses the JSON-RPC wire envelope declared in §JSON-RPC Wire Mapping below — the dotted-namespace `code` from this envelope rides as `data.type` on the JSON-RPC side. The two surfaces share the same project code registry (§Error Codes); only the framing differs.

**HTTP status overrides.** Most control-plane refusals map to tRPC's default status for their error kind (400/401/403/404/409/429). Where a code **served over control-plane tRPC** has a table row pinning a status the defaults cannot express, the pin is enforced by a contracts-level map, `AIS_WIRE_HTTP_STATUS_OVERRIDES` (`packages/contracts/src/error.ts`): the control-plane `errorFormatter` stamps the mapped status onto `data.httpStatus`, and the tRPC fetch transport lifts it natively via `getHTTPStatusCode` — no `responseMeta` hook, and a mixed-status batch degrades to **207 Multi-Status** per tRPC's own batching rule. The map is the single registration point: a code whose table row pins a non-default status registers there rather than minting a transport hook (`artifact.relay_expired`'s 410 row joins when Plan-012 Tasks 7–10 build its tRPC surface; `approval.request_expired`'s 410 row joins only if it ever gains a control-plane tRPC surface — its V1 surface is daemon-side JSON-RPC, where §JSON-RPC Wire Mapping applies instead).

---

## JSON-RPC Wire Mapping

Local IPC traffic (Plan-006 daemon ↔ in-tree clients) frames errors per [JSON-RPC 2.0 §5.1](https://www.jsonrpc.org/specification#error_object), which structurally requires `code` to be a Number. The dotted-namespace identifier (the canonical project code in §Error Codes below) rides in `data.type` per the [RFC 7807 Problem Details](https://datatracker.ietf.org/doc/html/rfc7807) precedent for structured error responses and the [LSP 3.17 ResponseError](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#responseError) field convention. This section closes BL-103 and the BLOCKED-ON-C7 markers in Plan-006 Phase 2.

### Numeric Code Space (per JSON-RPC 2.0 §5.1)

| Numeric code | JSON-RPC name  | Triggered by                                                   |
| ------------ | -------------- | -------------------------------------------------------------- |
| `-32700`     | ParseError     | Frame body is not valid JSON                                   |
| `-32600`     | InvalidRequest | JSON parses but envelope is not a valid JSON-RPC Request shape |
| `-32601`     | MethodNotFound | Method is not registered against the dispatcher                |
| `-32602`     | InvalidParams  | Zod schema validation on `params` failed                       |
| `-32603`     | InternalError  | Handler-thrown unhandled exception or programmer-error path    |

The reserved range `-32768..-32000` is the JSON-RPC spec's prerogative; the project does NOT mint additional numeric codes inside that range. Project domain codes live as dotted-namespace strings in `data.type`.

### Two-Layer Envelope Shape

```ts
interface JsonRpcErrorEnvelope {
  readonly code: number; // one of the values above; the JSON-RPC §5.1 discriminator
  readonly message: string; // human-readable; sanitized at I-006-8 boundary (no stack/secret leak)
  readonly data?: {
    readonly type: string; // dotted-namespace project code (e.g. "session.not_found")
    readonly fields?: Record<string, unknown>;
    // structured detail (e.g. { setting: "max_workers", value: -1 })
  };
}
```

The numeric `code` is the JSON-RPC spec-mandated discriminator. The `data.type` is the canonical project code — the same dotted-namespace strings the §Error Codes tables register. Consumers MUST discriminate on `data.type` (not on `message`) for project-level error handling; `code` is for JSON-RPC-level discrimination only.

`data.fields` is optional structured detail. Producers MUST keep it free of sensitive content (no stack traces, no absolute paths, no secrets) per Plan-006 invariant I-006-8. The daemon's `mapJsonRpcError` substrate enforces I-006-8 a second time on the `data.fields` channel as defense-in-depth: every value passes through `sanitizeFields` (path redaction, length cap, JSON-unsafe value sentinels — `BigInt` / `NaN` / `Infinity` / `Symbol` / `Function` / circular references / hostile getters — and width / depth / node-count caps) before the envelope is serialized. Producer discipline remains primary; the substrate is the safety net that survives a future builder forgetting to redact.

### Plan-006 Tier 1 Domain Identifiers

| `data.type` | JSON-RPC `code` | Trigger |
| --- | --- | --- |
| `unknown_setting` | `-32602` | Bootstrap rejected an unrecognized SecureDefaults config key (per F-006p-1-2 + T-006p-1-4) |
| `transport.unavailable` | `-32603` | Loopback-fallback transport requested without operator opt-in (per F-006p-2-09 Tier 1 conservative gate) |
| `transport.message_too_large` | `-32600` | Inbound frame exceeded the 1MB body cap (per F-006p-2-05; the spec-required InvalidRequest classification per `Plan-006 §Phase 2: Wire Substrate` (T-006p-2-2) mapping). Distinct from Spec-001's `resource.limit_exceeded` (HTTP-429 domain quota saturation): a 413-semantic peer mis-framing of the wire layer. |
| `transport.invalid_protocol_version` | `-32600` | Per-request envelope-level `protocolVersion` field violates `Spec-006 §Wire Format` (BL-102 ratified): missing, wrong type, or fails the ISO 8601 `YYYY-MM-DD` shape. The substrate `dispatchFrame` gate in `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts#LocalIpcGateway` enforces per I-006-7 BEFORE handler dispatch; the handshake (`daemon.hello`) is exempt because the negotiation parameter rides in `params.protocolVersion`. Distinct from `protocol.version_mismatch` (NegotiationError, registry-side gate for incompatible negotiated versions on subsequent mutating ops): the wire-layer envelope shape gate fires once-per-frame, the registry-side gate fires once-per-incompatible-mutating-op. |

`data.fields` shape per code:

- `unknown_setting`: `{ setting: string, value: unknown }`
- `transport.unavailable`: `{ requested: string, reason: string }`
- `transport.message_too_large`: `{ limit: number, observed: number }`
- `transport.invalid_protocol_version`: `{ reason: "missing" | "wrong_type" | "invalid_format", observedType?: string }` (`observedType` is the JS-typeof tag of the offending value, present only when `reason === "wrong_type"`; the offending VALUE itself is NOT echoed back so client-supplied content does not leak through observability)

### Negotiation Refusals

`NegotiationError` throws (the gate-refusal codes in `packages/runtime-daemon/src/ipc/protocol-negotiation.ts`) and `DaemonHelloAck.reason` strings (the handshake-incompatible reasons in `packages/contracts/src/jsonrpc-negotiation.ts`) all map through the same envelope. The reason strings are canonicalized to dotted-namespace form per BL-103 closure:

| `data.type` | JSON-RPC `code` | Surface | Trigger |
| --- | --- | --- | --- |
| `version.floor_exceeded` | n/a (DaemonHelloAck.reason field) | DaemonHelloAck | Client below daemon's lex-min supported version |
| `version.ceiling_exceeded` | n/a (DaemonHelloAck.reason field) | DaemonHelloAck | Client above daemon's lex-max supported version |
| `protocol.handshake_already_completed` | n/a (DaemonHelloAck.reason field) | DaemonHelloAck | Second `daemon.hello` on a connection with latched outcome |
| `protocol.handshake_required` | `-32600` | NegotiationError | Mutating dispatch attempted in `pre` state (I-006-1) |
| `protocol.version_mismatch` | `-32600` | NegotiationError | Mutating dispatch attempted in `done-incompatible` state (`Spec-006 §Fallback Behavior`) |

### Plan-020 Tier 4 Domain Identifiers

The `gdpr.*` stub methods are registered daemon JSON-RPC handlers (Plan-020 D-020-3) that return the not-implemented envelope unconditionally. Per [§Numeric Code Space](#numeric-code-space-per-json-rpc-20-51) the project mints **no** custom numeric domain codes — the stub rides the standard `-32603` discriminator with its project code in `data.type`, exactly mirroring `transport.unavailable` (a registered handler deliberately unavailable in this configuration). Consumers discriminate on `data.type`, never on the coarse `-32603` (a bare `-32603` with no `data.type` remains a genuine internal error).

| `data.type` | JSON-RPC `code` | Trigger |
| --- | --- | --- |
| `gdpr.endpoint_not_v1` | `-32603` | A registered `gdpr.*` daemon stub (`gdpr.sessionPurge` / `gdpr.userExport` / `gdpr.userDelete`) was invoked in V1; the handler returns the not-implemented envelope unconditionally (Plan-020 I-020-17). Notional HTTP 501 in [§Error Codes → §GDPR](#gdpr). |

### Test-Side Discrimination

Test code asserting on JSON-RPC error envelopes MUST discriminate on `data.type` for project-level expectations and on `code` for JSON-RPC-level expectations. The pre-BL-103 substrate's code-string-only assertion (T-006p-1-4 unknown_setting test) widens to full-envelope-shape assertion as part of BL-103 closure:

```ts
// pre-BL-103 (code-string only — BLOCKED-ON-C7 conservative shape)
expect(caught.code).toBe("unknown_setting");

// post-BL-103 (full envelope)
expect(caught).toMatchObject({
  code: -32602,
  message: expect.stringContaining("unknown_setting"),
  data: {
    type: "unknown_setting",
    fields: expect.objectContaining({ setting: expect.any(String) }),
  },
});
```

---

## Error Codes

### Session

| Code | Description | HTTP Status |
| --- | --- | --- |
| `session.not_found` | Session does not exist or is not accessible | 404 |
| `session.already_closed` | Session has already been closed and cannot be modified | 409 |
| `session.limit_exceeded` | Session creation rate limit exceeded | 429 |
| `session.goal_delivery_failed` | A live-leg goal mutation (`session.goalUpdate` / `session.goalClear`) failed at the provider driver — no event appended, no goal change; acked legs reverted to the prior goal (`Spec-014 §Session Goals`, campaign B6; `data.fields`: `failedBindingIds`, `driverCode`) | 502 |
| `session.goal_mutation_in_flight` | A goal mutation was refused because a prior goal intent has not converged — whether still applying (legs `pending`/`acked`; the ordinary concurrent-update case) or compensating after a failure (an `acked` leg awaiting revert) — retry after convergence (`Spec-014 §Session Goals`, campaign B6; `data.fields`: `unconvergedBindingIds` — every not-yet-converged leg, any state) | 409 |

### Auth

| Code | Description | HTTP Status |
| --- | --- | --- |
| `auth.token_expired` | Authentication token has expired | 401 |
| `auth.token_invalid` | Authentication token is malformed or invalid | 401 |
| `auth.insufficient_scope` | Token does not have the required scope for this operation | 403 |
| `auth.dpop_mismatch` | DPoP proof does not match the bound token | 401 |
| `auth.principal_mismatch` | Body-supplied actor field (e.g. `approver`, `initiatorId`) disagrees with the verified PASETO `sub` claim; see [api-payload-contracts §Authenticated Principal And Authorization Model](./api-payload-contracts.md#authenticated-principal-and-authorization-model) | 403 |

### Run

| Code | Description | HTTP Status |
| --- | --- | --- |
| `run.invalid_transition` | Requested state transition is not allowed from the current run state | 409 |
| `run.not_found` | Run does not exist or is not accessible | 404 |
| `run.limit_exceeded` | Concurrent run limit exceeded | 429 |
| `run.recovery_failed` | Run recovery failed due to an internal error | 500 |
| `run.execution_root_released` | `run.resume` against a rolled-back run re-opened conversation-only whose execution context is released with no existing root (a disposed ephemeral clone / a retired worktree — nothing recreates it); run state unchanged. Plan-003 rollback extension; distinct from the setup-time `workspace.execution_root_unresolved` | 409 |
| `run.compaction_boundary_diverged` | `run.resume` against a run whose current position sits strictly below its newest current `usage.context_compacted` boundary (a boundary-diverged run — reachable only through a rewind settled before the boundary's late delivery); run state unchanged, non-resumable in V1. Plan-003 rewind-hardening extension (the two-point classification's resume backstop, Spec-003 §Required Behavior); same standing-refusal family as `run.execution_root_released` | 409 |

### Queue

Daemon-local run-queue control codes (Plan-003). Run-control authority is daemon-only ([ADR-003](../../decisions/003-daemon-backed-queue-and-interventions.md)), so — like the §Run namespace — these ride the daemon JSON-RPC wire with the dotted code as the canonical `data.type` identifier and the HTTP status as the control-plane-notional mapping; no separate §JSON-RPC numeric pin (the §Run domain-code convention).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `queue.persistence_unavailable` | New queued run-control work was rejected fail-closed because the daemon's queue-persistence layer is unavailable (Plan-003 I-003-1 / ADR-003 — block new queued work when persistence is unavailable) | 503 |

### Intervention

Intervention request-admission codes ([Spec-004 §Required Behavior](../../specs/004-provider-driver-contract-and-capabilities.md#required-behavior), campaign B3). Intervention **outcomes** deliberately resolve via the six-state lifecycle (`rejected` / `expired` / `degraded` are states, not error codes — [queue-and-intervention-model.md §Driver Result To Lifecycle Mapping](../../domain/queue-and-intervention-model.md#driver-result-to-lifecycle-mapping)); this namespace covers only request-level refusals that never produce an intervention row. The token deliberately collides with no `intervention.*` durable event name (`requested`/`accepted`/`applied`/`rejected`/`degraded`/`expired` — the never-collide rule, D-010-4 convention).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `intervention.idempotency_conflict` | A `clientIdempotencyKey` was reused with a differing payload; the original intervention is untouched and the conflicting request is refused (an identical retry is not an error — it replays the recorded outcome). Semantic payload conflict per the converging idempotency-key practice (`data.fields`: `targetRunId`, `interventionId` of the original) | 422 |

### Channel

Channel lifecycle codes (Plan-014, Tier-5 audit D-014-16). Daemon-only authority — same wire convention as §Run/§Queue (dotted code as `data.type`, HTTP status as control-plane-notional mapping). Code tokens deliberately avoid the Spec-005 event names `channel.created`/`channel.muted`/`channel.unmuted`/`channel.archived` (never-collide rule, D-010-4).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `channel.not_found` | Channel does not exist in the session (`data.fields`: `channelId`) | 404 |
| `channel.inactive` | Target channel is archived (terminal) and cannot admit new runs or lifecycle mutations; muted channels still admit — mute suppresses attention surfaces, not execution (D-014-12; `data.fields`: `channelId`, `state`) | 409 |
| `channel.name_reserved` | Requested channel name collides with the reserved bootstrap `main` channel name (`data.fields`: `name`) | 409 |

### Orchestration

Orchestration admission-refusal codes (Plan-014, Tier-5 audit D-014-16). Every code is a zero-residue create-time refusal — no run row, no queue item, no partial state survives the rejection (I-014-8); the daemon additionally records the refusal durably via the `orchestration.rejected` event (`Spec-014 §Example Flows` "records the refusal visibly"). The event name `orchestration.rejected` and these error codes share a root but no token collides with an event name. The parent-run-missing case reuses §Run `run.not_found` (no new semantic — D-014-16).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `orchestration.depth_exceeded` | Creating run is itself a child — V1 permits exactly one level of run nesting (`Spec-014 §Default Behavior`; `data.fields`: `parentRunId`, `maxDepth: 1`) | 409 |
| `orchestration.active_child_limit_exceeded` | Parent already has the configured number of active children (`data.fields`: `parentRunId`, `limit`, `activeChildCount`) | 429 |
| `orchestration.pending_limit_exceeded` | Session already has the maximum pending orchestration-created runs (`Spec-014 §Scheduler Limits`; `data.fields`: `limit`) | 429 |
| `orchestration.channel_limit_exceeded` | Admitting the run would open a new executing channel beyond the maximum concurrently executing channels (`Spec-014 §Scheduler Limits`; `data.fields`: `limit`) — the run may instead be held `queued`; this code fires only when the target channel's queue is also exhausted (a busy target channel with a full queue is `orchestration.queue_depth_exceeded` regardless of the executing-channel count) | 429 |
| `orchestration.queue_depth_exceeded` | Target channel already has an executing run and its queue is at maximum depth, so the run cannot be held `queued` (`Spec-014 §Scheduler Limits`: 25 per channel, subject to the Spec-001 per-session queue depth; `data.fields`: `channelId`, `limit`, `queuedCount`) | 429 |
| `orchestration.turn_limit_exceeded` | Target agent is at its consecutive-turn limit in the target channel (D-014-8 — the counter resets on an interleaving human or different-agent turn; `data.fields`: `agentId`, `channelId`, `limit`) | 429 |
| `orchestration.budget_exhausted` | Session cost ceiling reached — admission blocked until the session owner raises the limit; also fired for the unpriced-model-family admission block with `reason: 'unpriced-model'` + `modelFamily` in `data.fields` and the same threshold fields carrying the configured limit + committed spend (observed cost including unpriced terminal debits, plus active reservations), and for native-cap-escape reservation refusals — `reason: 'driver_capless'` when the target leg's driver lacks the `cost_cap` capability (fail-closed, Spec-004 matrix) — where `observedValue` carries committed spend (observed cost including unpriced terminal debits, plus active reservations) (`Spec-014 §Budget Policies` incl. §Cost Derivation And Absent-Cost Semantics, campaign B6; `data.fields`: `budgetType`, `limitValue`, `observedValue`, `reason?`, `modelFamily?`) | 429 |
| `orchestration.node_not_local` | `targetNodeId` names a node not attached to this daemon — V1 orchestration is single-node; cross-node dispatch is Spec-022/Plan-024 (D-014-9; `data.fields`: `targetNodeId`) | 422 |

### Cross-Node Dispatch

Cross-node dispatch intake-refusal codes (Plan-024, Tier-8 audit). Both are minted here to discharge the two **distinct** registered rejection reasons [Plan-005 CP-005-3](../../plans/005-session-event-taxonomy-and-audit-log.md#cross-plan-obligations) binds on Plan-024 — the §Approval closing paragraph's "minting one is Plan-024's call" applied to the canonicalizer's two payload refusals. Daemon-only authority, same wire convention as §Orchestration (dotted code as `data.type`, HTTP status as control-plane-notional mapping; no JSON-RPC numeric pin). Each refusal is also recorded durably by the target daemon as a `dispatch.rejected` event carrying the code as its payload `reason` ([Spec-005 §Cross-Node Dispatch](../../specs/005-session-event-taxonomy-and-audit-log.md#cross-node-dispatch-cross_node_dispatch)). This is the one namespace whose error prefix equals a registered Spec-005 event-category prefix, so the never-collide rule is checked explicitly: `payload_too_deep` and `payload_ill_formed` collide with none of the thirteen registered `dispatch.*` event names — `sent` / `received` / `rejected` / `approval_requested` / `approved` / `denied` / `executed` / `completed` / `failed` / `expired` / `result_buffered` / `approval_observed` / `result_observed` (D-010-4 convention).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `dispatch.payload_too_deep` | `action_payload` nests containers past the canonicalizer's depth ceiling — the `CANONICAL_JSON_MAX_DEPTH` policy refusal at Plan-005 T2.1, caught at intake and mapped here rather than surfaced as a raw throw (CP-005-3 obligation 1; `data.fields`: `dispatchId`, `capability`) | 422 |
| `dispatch.payload_ill_formed` | `action_payload` carries an unpaired UTF-16 surrogate in a string value or property name — the RFC 8785 §3.2.2.2 normative MUST-terminate at Plan-005 T2.1, caught at intake and mapped here. Deliberately distinct from `dispatch.payload_too_deep`: an over-deep payload and an ill-formed one are different client errors and CP-005-3 forbids their merger (CP-005-3 obligation 2; `data.fields`: `dispatchId`, `capability`) | 422 |

The depth refusal is checked first, so a payload defective both ways reports `dispatch.payload_too_deep` and never `dispatch.payload_ill_formed`. The depth ceiling is renegotiable with Plan-005 T2.1 (raising the constant is a two-way door); the well-formedness refusal is not — RFC 8785 §3.2.2.2 makes termination a normative MUST, so catch-and-map is the only available response there.

### Agent

Agent-surface codes (Plan-014, Tier-5 audit A-014-2 / D-014-16; the provider axis added 2026-08-26, D-014-26 — three codes).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `agent.not_found` | Agent does not exist in the session (`data.fields`: `agentId`) | 404 |
| `agent.not_ready` | Agent is not in the `ready` lifecycle state (`configured` / `disabled` / `archived` per [agent-channel-and-run-model.md §Lifecycle](../../domain/agent-channel-and-run-model.md#lifecycle)) or its driver is unavailable, so it cannot take a run (`data.fields`: `agentId`, `state`) | 409 |
| `agent.provider_axis_invalid` | A provider-axis member on `agent.attach` / `agent.configUpdate` names something the hosting node cannot honour: an unregistered driver, a model absent from the target driver's `listModels`, an effort absent from that model's `effortLevels`, or an output-speed value absent from that driver's `outputSpeedLevels` ([Spec-014 §Same-Agent Provider Switch](../../specs/014-multi-agent-channels-and-orchestration.md#same-agent-provider-switch), 2026-08-26; the output-speed arm added 2026-08-29 with the fifth axis). Refused **before** any turn is started on the target, so a rejected switch spends nothing. `data.fields`: `agentId`, `axis` (`driverName` \| `modelId` \| `effort` \| `outputSpeed`), `value`. The axis names are the member names of the request, so this discriminator is a strict **subset** of the five-member `AgentProviderAxis` union in [api-payload-contracts.md §Plan-014](./api-payload-contracts.md) rather than a second spelling of it — one axis vocabulary, one of whose members refuses elsewhere. The `outputSpeed` arm is **vocabulary validation and nothing else** (narrowed 2026-08-29 at the round-3 fold): it covers a target driver whose declared `outputSpeedLevels` is absent or empty — which makes the axis unsettable — and a value outside a vocabulary the driver did declare. It deliberately does **not** cover a driver declaring `output_speed: false`, which is the axis not existing on that provider rather than a bad value in it, and which refuses as the already-registered `driver.capability_unsupported` on the ordinary capability gate ([Spec-004 §The output-speed axis](../../specs/004-provider-driver-contract-and-capabilities.md#the-output-speed-axis), [Spec-014 §The mutation surface](../../specs/014-multi-agent-channels-and-orchestration.md#the-mutation-surface), and Plan-014 T2.16's validation leg all order it capability-check-then-value-check). Two canonical refusals for one request would leave implementers and clients to pick, so the gate that runs first owns the refusal. Both arms still refuse fail-closed before any unvalidated setting reaches a provider spawn. It does not cover an accepted switch that later could not be applied, which reaches the caller as the `agent.provider_switch_failed` terminal's own `output_speed_unavailable` reason instead; the two vocabularies stay separate for the reason [Spec-005 §Channel and Agent Lifecycle](../../specs/005-session-event-taxonomy-and-audit-log.md#channel-and-agent-lifecycle-session_lifecycle) already states. The `providerAccountId` axis is deliberately **not** covered here — an unregistered or unknown account refuses in the account plane's own namespace (`provideraccount.unknown` / `provideraccount.not_registered`), which is both the owner of that fact and the refusal [Spec-023 §Provider Authentication (Group B)](../../specs/023-first-run-onboarding.md#provider-authentication-group-b) already triggers a sign-in handoff on; duplicating it here would create a second answer to one question and route the operator nowhere | 400 |

### Approval

| Code | Description | HTTP Status |
| --- | --- | --- |
| `approval.not_found` | Approval request does not exist | 404 |
| `approval.already_resolved` | Approval request has already been resolved | 409 |
| `approval.request_expired` | Approval request has expired and can no longer be resolved | 410 |
| `approval.request_canceled` | Approval request was canceled (its run ended, its session closed, or its originating provider ask was retracted before resolution — Plan-010 T2.8's live-leg cancel ingress, campaign B13) and can no longer be resolved; also the late-CREATE refusal — a create arriving for an already-ended run or already-closed session (Plan-010 T2.12, campaign B13). The **late-CREATE refusal shape** carries a typed `reason` extension member — `'run_ended' \| 'session_closed'` — per RFC 9457 §3.2 extension-member practice, derived from live terminal state at refusal time (a retraction can never cause a late CREATE — the request already exists when a retraction settles it); the resolve-path 409 for an already-canceled request carries no `reason` (the cancellation cause is not persisted on `approval.canceled` — audit reconstructs it from the adjacent run/session terminal rows on the timeline, or for a retraction from the paired `driver_ask.canceled` row carrying the same `askId`) | 409 |
| `approval.persistence_unavailable` | A permission check or approval mutation was rejected fail-closed because the daemon's approval-persistence layer is unavailable (`Spec-010 §Fallback Behavior` — the sensitive action must not proceed) | 503 |
| `approval.policy_artifact_corrupt` | A content-addressed credential-policy / execution-posture artifact failed its read-boundary integrity check — the stored `artifact` bytes no longer re-hash to the row's `ref` (Plan-010 T2.9, campaign B13); the read fails closed and the consuming run takes `Spec-010 §Fallback Behavior`'s strict per-request posture, never the unverifiable policy | 500 |
| `approval.rule_not_found` | Remembered approval rule does not exist | 404 |
| `approval.rule_already_revoked` | Remembered approval rule has already been revoked | 409 |

The `approval.request_expired` / `approval.request_canceled` tokens deliberately differ from the Spec-005 durable event names `approval.expired` / `approval.canceled` so an error code never collides with an event name (the same never-collide rule the `runtimenode` namespace documents below; Tier-5 audit, D-010-4). No `approval.permission_denied` code exists in V1: the daemon IPC surface carries no caller principal (api-payload-contracts §Authenticated Principal, local-daemon endpoints), `PermissionCheck` denial is a normal `allowed: false` response rather than an error, and cross-user approval authorization is structurally absent until Plan-024 (Spec-022) — minting one is Plan-024's call. The B13 `approval.policy_artifact_corrupt` row deliberately does not reuse `artifact.hash_mismatch`: that code names Spec-012's file-artifact domain and its 409 a fetch-time conflict, while this failure is server-side stored-state corruption in the approval trust store (500) — family prefixes route by domain.

### User

Identity-key and WebAuthn-ceremony surface refusals (Plan-016 Phase 5, registered 2026-08-15 at the promotion pass; the two `webauthn_*` rows added 2026-09-01 by the WebAuthn-ceremony amendment, Phase 6). The two ceremony codes are served on **control-plane routes** rather than a daemon `user.*` method — the caller is the Electron main process over its own authenticated channel — so they carry no §JSON-RPC pin and the five-method `user.*` registry does not move.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `user.permission_denied` | Caller does not own the session named in a device identity-key roster read (the ownership predicate and the roster read are one SQL statement, so a session the caller does not own and a session that does not exist are refused byte-identically — no session-existence oracle, and the roster's set size, the number of devices the account runs, is never disclosed to a caller outside the account; Plan-016 T5.3 / I-016-13, the `runtimenode.permission_denied` roster-arm discipline). Domain authz code. | 403 |
| `user.webauthn_challenge_invalid` | The WebAuthn ceremony challenge presented at verification is unknown, already consumed, or expired — challenges are single-use and short-lived, consumed atomically by the fence's `DELETE ... RETURNING` (Plan-016 T6.4 / I-016-15, 2026-09-01 WebAuthn-ceremony amendment). Domain validation code. | 400 |
| `user.webauthn_verification_failed` | A WebAuthn registration or assertion response failed verification. Deliberately **one** code for every arm — bad signature, wrong origin, wrong `rpId`, unknown credential, regressed signature counter, and a user-verification bit disagreeing with the mode stored at registration — so the reply is no oracle for which check failed (Plan-016 T6.2 / T6.3 / I-016-16 / I-016-17, 2026-09-01 WebAuthn-ceremony amendment). Domain validation code. | 400 |
| `user.identitykeyregister_conflict` | Identity-key registration presented a `public_key` that differs from the stored one for its `(user_id, key_fingerprint)` pair — register-once, refused before any row write; a same-key replay is an acknowledged idempotent no-op, and silent rotation is prohibited (the control-plane half of ADR-021's Refuse-On-Rotation Invariant; Plan-016 T5.2 / I-016-12 — the user-tier mirror of `runtimenode.signingkeyregister_conflict`) | 409 |

### Runtime Node

These codes are registry-only (code + message; no structured `details`): no acceptance criterion needs structured detail, and a conflicting-session-id detail would risk cross-session info-leak. The domain token `runtimenode` matches the method namespace (`runtimenode.attach` / `runtimenode.capabilityupdate`) and deliberately differs from the `runtime_node.*` durable event-name namespace (separator differs) so an error code never collides with an event name.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `runtimenode.attach_conflict` | Runtime node is already actively attached to another session; detach before attaching elsewhere (transient — Plan-002 I-002-5 / T3.2 P9) | 409 |
| `runtimenode.attach_revoked` | Runtime node's attachment to this session was revoked; revocation is terminal (Plan-002 T3.2 P10) | 409 |
| `runtimenode.capabilityupdate_conflict` | Runtime node cannot be brought online via capability update (online requires a daemon-side capability declaration) — coordination-snapshot refresh refused (Plan-002 I-002-2 / T3.9). **Narrowed 2026-08-12 (BL-141 / ADR-025 D4, Plan-002 T3.10):** the former "no active attachment to refresh" arm moves to the uniform `runtimenode.permission_denied` negative, because a 409 distinguishable from the authorization refusal would disclose whether the named node has an active attachment. What remains is the genuine state guard — the attachment exists, the caller is authorized for it, and the requested `registering → online` transition is refused because the control plane is not the declaration authority | 409 |
| `runtimenode.signingkeyregister_conflict` | Signing-key registration presented a key that differs from the stored one for its `(session, node)` pair — register-once, refused before any row write; V1 specifies no daemon signing-key rotation ceremony, so refusal is the rotation policy (Plan-005 T4.10 per CP-005-7 leg B — the control-plane mirror of T4.2 `refuse_on_rotation`) | 409 |
| `runtimenode.permission_denied` | Caller is not authorized for the resolved runtime-node object or for the session it belongs to. **Signing-key surfaces:** on `runtimenode.signingkeyregister`, the caller's verified principal does not own the session (a session the caller does not own and a nonexistent session collapse into this one refusal — no session-existence oracle, per this family's no-info-leak header; the producer binding is the daemon-bound credential at account granularity, the widening named at `security-architecture.md §Per-Event Daemon Signature`); on `runtimenode.signingkeyroster`, the caller does not own the session (the ownership predicate and the roster read are one SQL statement — one READ COMMITTED snapshot, never reading `sessions` — so the two refusals are byte-identical). One code, two call sites with distinct messages — the `runtimenode.capabilityupdate_conflict` precedent; domain authz code; deliberately never tRPC `NOT_FOUND`, which this namespace reserves as the old-control-plane procedure-absence discovery signal (Plan-005 T4.10, Codex PR #274 rounds 3–4, 2026-07-31). **Runtime-node attach surfaces (BL-141 / ADR-025 ratified 2026-08-10, added 2026-08-12):** the same code is the uniform negative for `runtimenode.attach`, `runtimenode.heartbeat`, `runtimenode.capabilityupdate`, and the control-plane-only `runtimenode.roster` query. On the three mutating procedures the caller must own the resolved `runtime_node_attachments` row **and** own the session; on `roster` the predicate is session-scoped rather than row-scoped — the session's owner enumerates its full roster, and a caller who does not own it is refused rather than answered with an empty projection, so an empty response can never disclose session existence. `runtimenode.detach`'s negatives are deliberately **not** this code: where no attachment is visible to the caller (unknown node, already-`offline`, or attached where the caller cannot see) it keeps its existing idempotent `null` no-op, byte-identical to detaching an already-`offline` node — retry-safety survives and no existence bit leaks. Because a node's owner may always detach it, the global `idx_node_attachments_active` partial unique index can never pin a `node_id` forever (Plan-002 I-002-3). Per procedure, every applicable negative cause collapses into one byte-identical response — `attach`: unknown session ≡ session not owned; `heartbeat` / `capabilityupdate`: unknown node ≡ node not owned; `detach`: every invisible cause one identical `null`; `roster`: unknown session ≡ session not owned — no attachment-existence, ownership, or session-existence oracle, the same no-info-leak rule this family's header states. One residual is accepted and recorded rather than closed: `runtimenode.attach` still answers `runtimenode.attach_conflict` (409) when a `node_id` is actively attached somewhere the caller cannot see, a one-bit channel inherent to the global uniqueness constraint whose whole purpose is to be observable; it collapses into this code if I-002-5 is ever relaxed to per-session uniqueness (Plan-002 T3.10–T3.12) | 403 |

### PTY

Shared-terminal write-lease refusals (`Spec-002 §Required Behavior`, campaign B4 2026-07-06). The lease is exclusive per session: exactly one user holds terminal control at a time, and no holder means writes are refused (fail-closed).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `pty.control_not_held` | Terminal write or `session.releaseControl` attempted without holding the terminal write lease — acquire the lease first (null-holder-refuses-writes) | 409 |
| `pty.control_held_by_other` | `session.takeControl` refused: another of the account's devices holds the lease; `data.fields.holderUserId` names the holder on the JSON-RPC surface, mirrored as `details.holderUserId` on the HTTP `ErrorResponse` envelope (same value on both surfaces, via the canonical envelope's structured-context field) — handoff is explicit (holder releases, then take) | 409 |
| `pty.permission_denied` | `session.takeControl` by a caller that does not own the session; evaluated before any lease-state comparison — the refusal is ownership-determined and stable, never varying with mutable lease state (holder identity is session-visible device metadata via `pty.control_changed` and the roster's `controlHolder`; the ordering is authorization hygiene, not secrecy). `session.releaseControl` is deliberately exempt — release is holder-gated (`pty.control_not_held`), never ownership-gated: during the authorization-loss propagation window (a device revocation in flight) the affected holder's own release must not be refused, and on arrival at the lease authority the revocation force-clears the lease anyway (`Spec-002 §Required Behavior`, `reason: 'auto_released_authorization_lost'`), so no de-authorized hold outlives the signal. Domain authz code. | 403 |

### Workspace

| Code | Description | HTTP Status |
| --- | --- | --- |
| `workspace.not_found` | Workspace does not exist | 404 |
| `workspace.provisioning_failed` | Workspace provisioning failed due to an internal error | 500 |
| `workspace.mode_unsupported` | Requested execution mode is not supported for this workspace | 400 |
| `workspace.stale` | Workspace execution root is unavailable; new write runs are blocked until repair (`Spec-007 §Fallback Behavior`; thrown by the Plan-007 `assertWritable` write gate, CP-007-3) | 409 |
| `workspace.branch_mismatch` | `branch` mode bind-only verification failed: the bound checkout's current branch (the user's main checkout or linked worktree, per `workspaces.metadata.boundRoot`) does not match the requested branch context; the daemon never checks out, creates, or switches branches inside the bound checkout (`Spec-008 §Resolved Questions and V1 Scope Decisions`; Plan-008 D-008-9, Tier-5 audit; erratum 2026-09-06 — the row had said "main checkout", contradicting the cited Spec-008 sentence for the linked-worktree case) | 409 |
| `workspace.busy` | Workspace execution root is held by an active run; one holding run at a time in V1 (`Spec-008 §State And Data Implications`; Plan-008 D-008-16, Tier-5 audit) | 409 |
| `workspace.execution_root_unresolved` | A repo-bound run reached the setup gate with no resolved execution root for the workspace's selected mode and root preparation failed; the run parks in `starting` (`Spec-008 §Fallback Behavior`; Plan-008 D-008-16, Tier-5 audit) | 409 |
| `workspace.branch_name_required` | A writable-mode wire-initiated (pre-run) `repo.executionRootPrepare` omitted `branchName`: the Spec-008 slug rule's derivation inputs (queue-item summary / run id) exist only on the run-setup gate path, so wire prepares must carry the branch (Plan-008 D-008-19, Tier-5 audit) | 400 |

### Repo

Repo-mount attach/detach/resolution errors (Plan-007 D-007-3, Tier-5 audit). The `repo` namespace binds to the mount lifecycle; `workspace.*` binds to the bound-workspace lifecycle. `repo.outside_trust_envelope` and `repo.root_resolution_failed` messages MUST NOT echo the attempted path (error-sanitization discipline; the daemon substrate's `sanitizeFields` is the second layer).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `repo.not_found` | Repo mount does not exist | 404 |
| `repo.root_resolution_failed` | Canonical repository root could not be resolved for the supplied path; attach fails explicitly rather than guessing (`Spec-007 §Fallback Behavior`) | 422 |
| `repo.outside_trust_envelope` | Path or workspace binding resolves outside the session's declared local trust envelope (`Spec-007 §Required Behavior` + §Local Trust Envelope) | 403 |
| `repo.already_attached` | The resolved canonical root is already actively attached to this session on the same owning node (node-scoped active-mount uniqueness, Plan-007 D-007-7) | 409 |
| `repo.detach_conflict` | Detach refused while a dependent workspace is `busy`; no force-detach in V1 (`Spec-007 §Detach Semantics (V1 Definition)`) | 409 |

### Worktree

Worktree lifecycle errors (Plan-008 D-008-4, Tier-5 audit). The `worktree` namespace binds to worktree rows; mode-capability refusals stay on `workspace.mode_unsupported` (select-time, D-007-5) — there is deliberately no `worktree.unsupported` code, and prepare-time dynamic unavailability surfaces as `worktree.create_failed`. Failure messages MUST NOT echo attempted filesystem paths (error-sanitization discipline, same posture as §Repo).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `worktree.not_found` | Worktree does not exist | 404 |
| `worktree.create_failed` | Worktree creation failed (git error, filesystem error, or dynamic worktree unavailability at provisioning time); the owning workspace transitions to `stale` via `failReprovision` and the failure detail rides `workspace.stale` metadata | 500 |
| `worktree.branch_collision` | Caller-supplied branch name collides with a live checkout on the same mount; user intent is never silently adapted — daemon-derived default names ordinal-suffix instead (`Spec-008 §Resolved Questions and V1 Scope Decisions` collision policy) | 409 |
| `worktree.reuse_conflict` | Explicit reuse candidate is dirty without `acknowledgeDirtyCandidate`, incompatible with the requested branch strategy (never bindable), or no longer live (`Spec-008 §Fallback Behavior`) | 409 |
| `worktree.retire_conflict` | Retire refused while the worktree is the execution root held by an active run (busy owning workspace) | 409 |

### Ephemeral Clone

Ephemeral-clone lifecycle errors (Plan-008 D-008-4, Tier-5 audit). Same sanitization posture as §Worktree.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `clone.not_found` | Ephemeral clone does not exist | 404 |
| `clone.prepare_failed` | Ephemeral clone preparation failed; the owning workspace transitions to `stale` via `failReprovision` and the run stays blocked in setup (`Spec-008 §Fallback Behavior`) | 500 |

### Artifact

| Code | Description | HTTP Status |
| --- | --- | --- |
| `artifact.not_found` | Artifact does not exist | 404 |
| `artifact.too_large` | Artifact exceeds the maximum allowed size — `max_attachment_ingest_bytes` on the ingest path (checked before any parser reads the payload), `max_artifact_relay_bytes` on the relay publish path, and — per the stream protocol's reservation rule (2026-08-17, PR #341 round-4 fold) — an ingest stream's own Init-declared total, enforced as its spool reservation and per-stream ceiling: a chunk pushing the running decoded count past the declaration is this refusal with the spool deleted, even when the declaration sits far below the cap | 413 |
| `artifact.too_many_attachments` | A turn-scoped attachment carrier names more elements than `max_attachments_per_carrier`; the **whole carrier** is refused at carrier acceptance, before any element is bound or delivered, leaving no partial carrier state — no binding, no delivery, no marker. The carrier names already-minted `ArtifactId`s, so the refusal ingests nothing and un-ingests nothing: artifacts minted by earlier `AttachmentIngest` calls are untouched and follow their own lifecycle (corrected 2026-08-17, PR #341 round 4 — the earlier "before any element is ingested / no orphaned artifacts" description predated the typed-carrier fold and would recreate batch-ingest semantics) (reserved — registers with Plan-012 per [Spec-012 §Ingest Validation And Payload Bounds (V1)](../../specs/012-artifacts-files-and-attachments.md#ingest-validation-and-payload-bounds-v1)) | 413 |
| `artifact.unsupported_media_type` | Ingested payload's **derived** media type is not allow-listed, contradicts the caller's declared `mediaType`, or is undetermined without an allow-listed signature-exempt declaration; the bytes are quarantined, never persisted as a normal artifact and never silently re-typed (reserved — registers with Plan-012 per [Spec-012 §Ingest Validation And Payload Bounds (V1)](../../specs/012-artifacts-files-and-attachments.md#ingest-validation-and-payload-bounds-v1)) | 415 |
| `artifact.scanner_rejected` | An operator-configured step-8 scanner returned a rejecting verdict for an otherwise-admissible payload; the bytes are quarantined per step 9. Deliberately distinct from `artifact.unsupported_media_type`: the payload's type was allow-listed and reconciled before the seam ran, so the refusal is a content verdict and a media-type code would misdirect the remedy. The default no-scanner configuration never produces this code (reserved — registers with Plan-012 Task 11 per [Spec-012 §Ingest Validation And Payload Bounds (V1)](../../specs/012-artifacts-files-and-attachments.md#ingest-validation-and-payload-bounds-v1)) | 422 |
| `artifact.ingest_capacity_exhausted` | `AttachmentIngestInit` refused because the open-stream count has reached `max_active_ingest_streams` or the aggregate of open streams' declared totals would breach `ingest_spool_max_bytes` — transient backpressure, retry later, **no stream state created** — no `ingestId` is minted, no count slot consumed, and no reservation held, so releasing one open stream admits the next Init; because the refusal issues no id, the zero-state property is observable through that next admission rather than through any identifier the caller could probe (clarified 2026-08-17 by the ingest-protocol hardening amendment, which also made admission a serialized reserve-then-install section so two concurrent Inits cannot both pass the bound). Deliberately distinct from the terminal `artifact.ingest_stream_invalid`: this one asks the caller to wait, that one to restart (reserved — registers with Plan-012 Task 11 per [Spec-012 §Ingest Validation And Payload Bounds (V1)](../../specs/012-artifacts-files-and-attachments.md#ingest-validation-and-payload-bounds-v1) stream protocol, added 2026-08-17 at the PR #341 round-4 fold) | 429 |
| `artifact.ingest_stream_invalid` | An ingest stream call that cannot proceed and cannot be retried in place: a sequence gap, regression, or same-sequence different-bytes chunk (which terminates the live stream and deletes its spool), any call on a terminated or lifetime-expired stream, an unknown `ingestId`, or a `Chunk` on a completed stream. The remedy is restart from Init. **Two replays are deliberately NOT this code**, because a lost response must never cost the caller its upload: an **exact replay of the last acknowledged chunk** — same sequence, same bytes — is acknowledged idempotently without re-appending; and a **replayed `Complete` on a completed stream whose completion record is still held** replays that record's original response verbatim, re-running no pipeline step and minting no second manifest row (the carved exception added 2026-08-17 by the ingest-protocol hardening amendment; the record shares the stream registry entry's in-memory lifetime, so past `max_ingest_stream_lifetime` the same retry does receive this code) (reserved — registers with Plan-012 Task 11 per the same stream protocol, added 2026-08-17 at the PR #341 round-4 fold) | 409 |
| `artifact.hash_mismatch` | Artifact content hash does not match the expected value | 409 |
| `artifact.delete_blocked` | `ArtifactDelete` refused because another manifest names the target as its `subject` — the derivative-provenance chain of I-012-2 may not be severed, and nulling the referent's `subject` is prohibited rather than performed. The response names the referencing manifests via the typed `ArtifactDeleteBlockedDetails` shape (`referencingArtifactIds` — bounded to the first 50 ascending plus `referencingArtifactTotal`, so the refusal always fits the 1 MB frame; [api-payload-contracts.md §Plan-012](./api-payload-contracts.md#plan-012--artifacts-files-and-attachments)) so the caller can delete the derivatives first; the target is otherwise untouched (reserved — registers with Plan-012 Task 12 per [Spec-012 §Local Artifact Deletion And CAS Reclaim (V1)](../../specs/012-artifacts-files-and-attachments.md#local-artifact-deletion-and-cas-reclaim-v1)) | 409 |
| `artifact.delete_forbidden` | `ArtifactDelete` refused because the caller is outside the permission-matrix Delete rule — the session's owner may delete any of its artifacts, and nothing else may delete any ([security-architecture.md §Permission Matrix (Task 5.4)](../security-architecture.md#permission-matrix-task-54)). Refused **before any mutation**: the target manifest, its payload references, and the CAS bytes are unchanged. Deliberately distinct from `artifact.delete_blocked`, which is referential integrity a differently-ordered delete sequence remedies — this one no delete order does (reserved — registers with Plan-012 Task 12 per [Spec-012 §Local Artifact Deletion And CAS Reclaim (V1)](../../specs/012-artifacts-files-and-attachments.md#local-artifact-deletion-and-cas-reclaim-v1)) | 403 |
| `artifact.relay_expired` | Relay blob TTL-expired or evicted; payload no longer fetchable from the relay. **Two producers, both settled 2026-08-26** by the relay TTL-sweep disposition amendment ([Spec-012 §TTL sweep disposition (V1)](../../specs/012-artifacts-files-and-attachments.md#ttl-sweep-disposition-v1), closing BL-152): a blob past `expires_at` whose hourly sweep has not yet run — relay read paths evaluate liveness as `state = 'pinned' AND expires_at > now()`, so this code is correct with no sweep in existence — and a swept blob still standing as a payload-free tombstone at `state = 'expired'`, which the sweep retains for `relay_tombstone_grace` (30 d default) precisely so this 410 is available instead of an indistinguishable 404. Once that tombstone is purged the same fetch falls to the zero-row `artifact.no_access_key` (404) arm. **Both producers are grant-blind by construction**: liveness is evaluated ahead of the recipient-row selector, so an authenticated session member holding no grant at all receives this 410 for a non-live blob rather than the 404 — deliberate, since the remedy is identical under both codes and the sweep's shred has destroyed the rows that could distinguish them. **Receiving this code carries a local side effect on the fetching node** (added 2026-08-17 by the ingest-protocol hardening amendment): on any arrival — the `ArtifactFetchAuthorize` mint, a chunk GET, or a resume after mid-fetch eviction — the fetching daemon transitions that artifact's own `artifact_manifests.replication_status` from `pinned` to `expired` before surfacing the error, which is what makes the `expired` member of the unresolved-attachment cause union reachable from persisted state instead of naming a value no row ever carries. A loss that instead removed the blob row cascades its recipient rows away and surfaces as a zero-row `artifact.no_access_key` (404), which carries the **same** side effect (see that row) — the write-back is bound to the fact that the payload is unobtainable, not to either code alone. Idempotent, applied only to a `pinned` row, and undone by an ordinary re-publish re-pin ([Spec-012 §Fetch (authenticated; relay-served in V1)](../../specs/012-artifacts-files-and-attachments.md#fetch-authenticated-relay-served-in-v1)) (reserved — registers with Plan-012 Tasks 7–10 per [Spec-012 §Failure modes](../../specs/012-artifacts-files-and-attachments.md#failure-modes-normative-responses)) | 410 |
| `artifact.fetch_unauthorized` | Artifact fetch token refused: non-member, expired, DPoP-unbound, the thumbprint selector's fail-closed multi-match refusal, or a resolved recipient row whose derived node holds no active attachment by the authenticated user in the blob's session — states a publisher re-publish does not remedy, which is what separates this code from `artifact.no_access_key` (reserved — registers with Plan-012 Tasks 7–10 per [Spec-012 §Failure modes](../../specs/012-artifacts-files-and-attachments.md#failure-modes-normative-responses)) | 403 |
| `artifact.no_access_key` | The authenticated caller has no `artifact_relay_recipients` row for the requested digest. **Three indistinguishable producers, all reached only against a live pin** (enumerated 2026-08-17 by the ingest-protocol hardening amendment; live-pin scoping added 2026-08-26 — a blob that is not a live pin takes `artifact.relay_expired` (410) ahead of the selector), all sharing the re-publish remedy: a `(user, node)` pair that linked after publish (recipient-epoch scoping, Spec-012 Publish step 3); a blob removed by refcount-zero delete or watermark eviction, whose recipient rows cascade away with it, **or a TTL-swept blob whose tombstone has since been purged** (Spec-012 Fetch steps 6 and 8; narrowed 2026-08-26 — a TTL-swept blob _inside_ `relay_tombstone_grace` is refused the typed 410 instead, so this producer no longer covers the whole TTL path); and a recipient entry dropped fail-closed in a thumbprint collision (Spec-012 Publish step 3). **Receiving this code carries the same local side effect as `artifact.relay_expired`**: against a manifest row still reading `pinned`, the fetching daemon transitions it to `expired` before surfacing the error — the write-back keys on the payload being unobtainable, so neither code alone is sufficient. Because the three producers are unobservable to the refused node, `expired` is read as _payload not obtainable from the relay; remedy is a re-publish_ rather than narrowly as _TTL elapsed_ ([Spec-012 §Fetch (authenticated; relay-served in V1)](../../specs/012-artifacts-files-and-attachments.md#fetch-authenticated-relay-served-in-v1)). Deliberately distinct from `artifact.fetch_unauthorized` so clients can surface the remedy (publisher re-publish while online) instead of treating it as an auth failure (reserved — registers with Plan-012 Tasks 7–10 per [Spec-012 §Cross-Node Artifact Relay (V1)](../../specs/012-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1)) | 404 |

Chunk-integrity mismatch on relay fetch reuses `artifact.hash_mismatch` (409). **Ten rows are reserved rather than live**, in three cohorts. The relay cohort — `artifact.relay_expired`, `artifact.fetch_unauthorized`, `artifact.no_access_key` — is named by Spec-012's 2026-07-08 cross-node relay amendment (the no-access-key row by its 2026-07-09 extension); the ingest cohort — `artifact.too_many_attachments`, `artifact.unsupported_media_type`, `artifact.scanner_rejected` (added 2026-08-17 by PR #341's round-2 Codex fold), and `artifact.ingest_capacity_exhausted` plus `artifact.ingest_stream_invalid` (both added 2026-08-17 by the round-4 fold's stream protocol) — and the deletion cohort — `artifact.delete_blocked` plus `artifact.delete_forbidden` (added at the round-2 fold) — by its 2026-08-16 artifact-lifecycle amendment and those folds. All ten become live registrations with Plan-012's own legs when tier order reaches them. Plan-012's relay-scope readiness-audit delta landed 2026-08-12 and restored it and Spec-012 `approved`, binding `artifact.relay_expired` to Task 9's TTL-sweep assertion, `artifact.too_large` to Task 7's over-cap arm, and both of the fetch rows to Task 8's; the 2026-08-16 delta binds the two 2026-08-16 ingest rows to Task 11's validation assertions, `artifact.delete_blocked` to Task 12's `subject`-refusal assertion, and widens `artifact.too_large` to cover the ingest size cap alongside the relay one; the round-2 fold binds `artifact.scanner_rejected` to Task 11's scanner-seam assertion and `artifact.delete_forbidden` to Task 12's authorization assertion; and the round-4 fold binds the two stream-protocol rows to Task 11's admission and sequencing assertions — and widens `artifact.too_large` a second time, to the reservation-breach arm (a chunk exceeding its stream's Init-declared total), bound to Task 11's reservation assertion. **The 2026-08-17 ingest-protocol hardening amendment mints no code and moves no census — the ten rows and three cohorts above are unchanged.** It narrows two descriptions and adds one side effect: `artifact.ingest_stream_invalid` carves a single exception for a replayed `Complete` on a completed stream whose completion record survives (bound to Task 11's completion-record assertion), `artifact.ingest_capacity_exhausted` states the zero-state property in the form a caller can actually observe, and `artifact.relay_expired` now carries the local `pinned` → `expired` manifest write-back that grounds the unresolved-marker `expired` cause (bound to Task 9's write-back assertion). On the fetch-mint path the two refusals stay deliberately distinct: a thumbprint selector matching **zero** rows is `artifact.no_access_key` (404, remedy = publisher re-publish), while one matching **two or more** is `artifact.fetch_unauthorized` (403, refused fail-closed and never narrowed) — different remedies, so one code for both would mislead every client. The corroboration failure — exactly one row, but the derived node holds no active attachment by the authenticated user in the blob's session — also maps to `artifact.fetch_unauthorized`: the caller already holds a wrapped-CEK grant, so 404's re-publish remedy would mislead; the remedy is re-attaching the node (Spec-012 Fetch step 5). **The 2026-08-26 relay TTL-sweep disposition amendment likewise mints no code and moves no census — the ten rows and three cohorts above are unchanged.** It settles the producers of two already-reserved rows rather than adding a third: `artifact.relay_expired` gains its read-time-enforcement and tombstone-window producers (still bound to Task 9's sweep assertions, and now also to Task 8's read-time-liveness assertion), and `artifact.no_access_key`'s second producer is narrowed to exclude a TTL sweep still inside its grace window. The write-back both codes carry is unchanged and stays keyed on the payload being unobtainable rather than on either code.

### Workflow

| Code | Description | HTTP Status |
| --- | --- | --- |
| `workflow.not_found` | Workflow definition does not exist | 404 |
| `workflow.invalid_phase` | Requested phase transition is invalid | 400 |
| `workflow.gate_closed` | Workflow gate has not been resolved and blocks progression | 409 |
| `workflow.start_denied` | Workflow run start refused — a denied or unresolvable chat-borne principal under the SA-39 named-action adjudication, or a `channelId` naming a channel the session does not hold (SA-38 channel validation); one code, ordered arms with scoped disclosure — the principal arm runs first, and the SA-38 channel validation runs second, only for an admitted start, collapsing an out-of-session channel and a nonexistent channel into one byte-identical message (no channel-existence oracle — the `runtimenode.permission_denied` collapse-where-it-leaks shape); Cedar-denial-as-domain-code per the `mcp.governance_denied` precedent (ADR-027) | 403 |
| `workflow.repair_not_parked` | Frozen-definition re-pin refused: the target run is not parked — a running instance is never re-pinned, unconditionally, per [Spec-015 §Frozen-definition repair (SA-41)](../../specs/015-workflow-authoring-and-execution.md#frozen-definition-repair-sa-41); the refusal is total, leaving the run unchanged on its original pinned version (registers with Plan-015 T5.12) | 409 |
| `workflow.repair_attempt_in_flight` | Frozen-definition re-pin refused: an attempt of the run is still in flight — the park's resume continues one rather than entering a phase fresh (the SA-40 usage-limit park by construction, which mints no new `phaseRunId`), or a parked parallel sibling holds one that will continue later — so the refusal names the blocking attempt and the explicit fresh-entry action that would discard it, instead of swapping the run-level definition pointer under units already dispatched from the frozen bytes (`Spec-015 §Frozen-definition repair (SA-41)`, the run-wide fresh-entry rule; refusal is total; registers with Plan-015 T5.12) | 409 |
| `workflow.repair_version_unaccountable` | Frozen-definition re-pin refused: the target version cannot account for the phases the run already completed — it omits a phase id whose outputs the run holds, or its declared topology would leave a completed phase unreachable, which `Spec-015 §Frozen-definition repair (SA-41)` states is one failure rather than two; refusal is total, leaving the run parked on its original version with its schedule state untouched (registers with Plan-015 T5.12) | 409 |
| `workflow.control_denied` | Operator run control refused by authorization — the caller is not admitted for `Action::"workflow::cancel"` on `workflow.runCancel` or `Action::"workflow::resume"` on `workflow.runResume`, adjudicated through `PermissionCheckService` exactly as `Action::"workflow::start"` is (`Spec-015 §Operator run control (SA-45)`; Cedar-denial-as-domain-code per the `mcp.governance_denied` precedent). **One code, two ordered arms** — the arm is named in the message because the two actions are separately grantable and an operator denied only resume needs to know which grant they lack; no run-existence oracle is opened, because the caller must already hold session read access to name a `workflowRunId` (the `workflow.start_denied` scoped-disclosure shape). Refused **before any mutation**: run status, phase rows, and armed schedules are untouched (registers with Plan-015 T5.14) | 403 |
| `workflow.run_not_cancellable` | `workflow.runCancel` refused because the run already reached a terminal outcome — `completed` or `failed` — so there is nothing to cancel and reporting success would misinform the operator about what their action did. Deliberately **not** the answer for a run already `cancelled`: that call replays idempotently on the original `workflow.cancelled` event with `alreadyCancelled: true`, minting no second status write and no second event, because a retried cancel must never cost the operator a clear answer. Equally not the answer for a parked run — `Spec-015 §Park integrity and cancellability (SA-42)` makes a parked run cancellable **without precondition**, and that rule is unchanged (registers with Plan-015 T5.14) | 409 |
| `workflow.resume_not_parked` | `workflow.runResume` refused because the target run is not parked — there is no suspension to lift, so a resume would either be a no-op dressed as an action or a second dispatch of a running phase. Distinct from `workflow.repair_not_parked`, which refuses the **re-pin leg** of a resume under `Spec-015 §Frozen-definition repair (SA-41)`: that code names a repair the run's state forbids, this one names a resume the run's state forbids, and collapsing them would leave an operator unable to tell whether dropping the re-pin would have worked. Refusal is total; the run is unchanged. Resuming a parked run **ahead of** an armed `autoResumeAt` is not a refusal at all — the schedule is advisory pacing, the resume proceeds, and a still-spent provider account simply re-parks with its own `workflow.phase_suspended` (registers with Plan-015 T5.14) | 409 |

The `workflow.start_denied` row landed as the first entry of the extension the surface already owes (Plan-015 A-015-15 — three legacy codes against what is now a nineteen-refusal-point surface: the fifteen counted at the 2026-08-11 chat-start amendment, that row itself, and three from the 2026-08-16 workflow-hardening amendment's SA-41 frozen-definition repair path), and the three `workflow.repair_*` rows above — registered at that amendment's review round — land the SA-41 slice in full: a re-pin against a run that is not parked, one requested while any of the run's attempts is still in flight (the resuming phase continuing one rather than entering fresh, or a parked parallel sibling holding one), and one whose target version cannot account for the phases the run already completed. The 2026-08-18 park-surface + operator-controls amendment then added the three `workflow.control_denied` / `workflow.run_not_cancellable` / `workflow.resume_not_parked` rows above with the operator-recovery operations they serve, minting each code in the same diff as its refusal so no unregistered refusal ever ships (`Spec-015 §Loud-errors discipline (C-12)`). **Census arithmetic (re-derived 2026-08-18, not carried forward):** nineteen at the 2026-08-17 review round, plus three operator-recovery points — an authorization denial on either operation (one point, two ordered arms, one code), a cancel against a terminal-outcome run, and a resume against an unparked run — = **twenty-two**. `workflow.runResume`'s optional re-pin leg adds none: its three refusals are the SA-41 points already counted. **Seven of the twenty-two refusal points now carry codes; the remaining fifteen still await the extension** — that owed count is unmoved, because every point added since the extension was first owed has landed with its code. This paragraph previously closed by asserting that the park surface adds no code of its own, on the ground that SA-42 makes a parked run cancellable without precondition. That ground still holds and is why no code names a refused cancellation **of a parked run** — but it was never a claim about the surface as a whole, and the operator-recovery operations falsify the broader reading: reaching cancellability and resumption over the wire needs an authorization decision and two state guards that a parked run's unconditional cancellability says nothing about. The SA-40 park itself remains a state transition rather than a caller-visible refusal.

### Driver

Driver codes ride the daemon JSON-RPC wire with notional HTTP statuses, with **one exception recorded here rather than only in its row**: `driver.text_neutralization_failed` rides no **error** envelope on any path. It lands as the leading token of `providerFailureDetail` on the run's `run.failed` event, and — on the intervention path only, where a caller exists — additionally, **best-effort** when the trip is classified before that call resolves, as the closed-literal `DriverInterventionResult.refusalCode` on the caller's ordinary result (`Spec-004 §Required Behavior`). Its status column is therefore notional in place of _any_ error response, not merely in place of an HTTP one.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `driver.unavailable` | Provider driver is currently unavailable | 503 |
| `driver.capability_unsupported` | Requested capability is not supported by the driver. **Producers (2026-09-08 clause, erratum-class — no code is minted and no census moves):** the `ProviderRegistry` pre-dispatch flag gate and the IPC layer's driver-implements-the-operation check, and — since PR #461's round-5 closing fix — a `driver.applyIntervention` **steer whose `attachments` list is non-empty**, refused **whole** at the single daemon ingress before any driver method runs. That third producer is the same fact as the other two: no V1 driver declares an attachment-delivery leg and no daemon seam yet resolves an `ArtifactId` to bytes, so the carrier the contract types cannot be honoured — and the alternative is a supported steer answering `applied` after silently dropping every element, which is the loss the typed carrier exists to prevent. `data.fields` is **producer-dependent and closed at two wire shapes**, always carrying `driverId`: the registry's flag gate emits `{ driverId, flag }` (`flag` a `DriverCapabilityFlag`, forwarded unchanged by the IPC layer's driver-error translation), while the operation check and the attachment refusal emit `{ driverId, operation }` (`operation` a `ProviderDriver` method name — the attachment refusal takes this shape because no capability flag governs it, only the operation). A consumer reads whichever discriminating member is present and must not reject the other; no new fields member is minted. It lifts when the daemon's attachment-reference resolver ships, at which point the arm is delivered rather than refused | 400 |
| `driver.timeout` | Provider driver operation timed out | 504 |
| `driver.cli_version_unparseable` | The provider CLI's reported version could not be parsed to a semantic version; capability attach/refresh fails closed and runs cannot start on this driver until the provider install is repaired (`Spec-004 §Required Behavior`, campaign B3 — the `workspace.stale` blocked-until-repair convention) | 409 |
| `driver.cli_version_below_floor` | The provider CLI's reported version parsed cleanly but is below the configured per-driver minimum floor; capability attach/refresh fails closed until the provider install is upgraded (`Spec-004 §Required Behavior`, campaign B3 — distinct from `version.floor_exceeded`, which is scoped to client/event-envelope contract floors, not provider CLI installs) | 409 |
| `driver.not_authenticated` | The zero-turn `probeAuth` did not report `authenticated` (`unauthenticated`, or `indeterminate` treated fail-closed); run admission is refused before any billed turn — remediation is re-authenticating the provider CLI on the runtime node (`Spec-004 §Required Behavior`, campaign B3). Mid-run credential expiry is the separate `reauth-required` `RecoveryCondition`, not this code | 409 |
| `driver.text_neutralization_failed` | An outbound provider frame carrying **neutralized prose** — every frame origin except `driver_command`, the absent-or-unrecognized arm included, since `Spec-004 §Required Behavior` neutralizes those too — settled without any typed evidence that the provider ran a model turn for it, so the frame was consumed by the provider's own client-side command surface and the driver's command-shaped-text neutralization did not hold on this provider install. **Every tripwire arm can produce it**, the boundary and the tripwire being universal while only the transform is grade-scoped: a leg graded `native` — which prepends no sentinel, having been probed as delivering bytes verbatim — trips exactly as an `emulated` one does when its provider starts command-dispatching after an update, and that is the case this code exists for, re-grading being the remedy rather than discovering the loss from a user; the daemon fails the run rather than recording the provider's zero-turn success as a completed turn (`Spec-004 §Required Behavior`, the 2026-08-25 provider-bound text-neutrality amendment). **One landing, never an error envelope.** This code is a machine-readable **cause identifier**, not a wire refusal: it is carried as the leading token of `providerFailureDetail` on the run's ordinary `run.failed` terminal, beside `failureCategory: 'provider failure'` and `recoveryCondition: 'recovery-needed'` ([api-payload-contracts.md](./api-payload-contracts.md)). The detail's **exact form is fixed** by `Spec-004 §Required Behavior` so a consumer can parse it: this code, one space byte (`0x20`), then `origin=` followed by one of `human_text`, `system_narration`, or `unknown` — `driver.text_neutralization_failed origin=human_text` in full. The cause is the substring before the first space; the origin is the substring after `origin=`. That form binds this cause alone and leaves `providerFailureDetail` free-form prose for the resume failure that introduced the field. Neither provider-bound path can raise it as a JSON-RPC error — `startRun` is a daemon-internal lifecycle operation with no wire method behind it, and an intervention settles `degraded` on its own result branch — and a registered code riding a non-error surface is the established convention here, `InterventionResponseBase.rejectionReason` carrying `driver.capability_unsupported` exactly that way. The origin rides that same detail so the record says whose words failed to arrive and daemon-composed narration is never filed as a user's; an unrecognized origin is recorded as the literal `unknown` and the value the daemon did not compose is **never echoed** into the durable record. Detected by classifying the provider's response **to that frame** — the daemon mints a per-frame correlation value and the driver requires positive typed turn evidence for it, an unrecognized response envelope tripping rather than passing, the discriminants pinned against the shipped binaries by Plan-004 T3.18's currency step — and **never** by matching message prose, which `Spec-004 §Pitfalls To Avoid` forbids for exactly the localization and wording-drift reasons it forbids text-matched quota refusals. **409 is notional**, retained to place this code in the blocked-until-repair family `driver.cli_version_unparseable` already uses rather than to describe a response it never rides (the §Queue daemon-local convention, one step further): the provider is reachable and healthy, so an availability code would misdirect the remedy, and the repair is escalating the driver's neutralization ladder or moving to a provider build whose parse the shipped sentinel defeats. Frames the driver composed as commands in their own right (origin `driver_command`) are exempt by construction and can never produce this code (reserved — registers with Plan-004 T3.18) | 409 |

### Provider Account

Refusals on the node-local provider-account plane ([Spec-026](../../specs/026-provider-accounts-and-credential-homes.md)). Every one of these is **fail-closed**: the daemon refuses the run rather than falling back to ambient credentials, to a different account, or to an unvalidated home. A silent fallback here would execute against an account the operator did not choose and bill spend to a party that never authorized it, so there is deliberately no permissive path.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `provideraccount.not_registered` | No account is registered for the requested provider; a provider run cannot be admitted. The remedy is registration, not a default — there is nothing to default to | 400 |
| `provideraccount.no_default` | Accounts exist for the provider but none is marked default and the request supplied no per-run override, so resolution is ambiguous and refuses rather than picking one | 400 |
| `provideraccount.unknown` | The referenced `providerAccountId` is not present in the registry (never registered, or removed after the reference was taken) | 404 |
| `provideraccount.credential_home_unavailable` | The account's credential home is missing, unreadable, or structurally unusable; the run is refused rather than rebound to another account's home (I-026-8) | 503 |
| `provideraccount.not_authenticated` | Pre-spawn validation did not report `authenticated` — including the `indeterminate` probe result, which is treated as not-authenticated rather than assumed healthy (I-026-3) | 401 |
| `provideraccount.permission_denied` | The caller lacks node-operator authority for a mutating registry verb, or the per-run account override is denied by policy; a relayed mutation is refused on the same code (I-026-1) | 403 |
| `provideraccount.default_conflict` | A concurrent set-default lost the partial-unique-index race; the database refused the second writer rather than leaving two defaults for one provider (I-026-5) | 409 |
| `provideraccount.signin_unsupported` | Brokered sign-in was requested for a provider whose pinned flow emits neither an authorization URL nor a device code, so there is nothing the operator could act on. The daemon refuses rather than spawning a flow that cannot be completed; the remedy is the out-of-band sign-in the readiness handoff already discloses ([ADR-028](../../decisions/028-provider-credential-custody-posture.md) D1) | 400 |
| `provideraccount.signin_in_flight` | A brokered sign-in is already in flight for this account. Refused rather than started, because at least one pinned provider holds exactly one active login slot and **silently drops the previous attempt** — a permissive second start would strand an operator mid-flow on another device with no signal that their code had stopped working. The remedy is `providerAccount.loginCancel` on the in-flight attempt | 409 |
| `provideraccount.token_class_refused` | A value supplied on `ProviderAccountRegisterRequest.nonInteractiveToken` failed one or more of [ADR-028](../../decisions/028-provider-credential-custody-posture.md) D2's five conjunctive admission conditions. **The refusal message names which condition failed and never quotes, echoes, or excerpts the supplied value** — a refusal that reflected the input back would disclose it through the error channel the rest of this plane keeps clean. The remedy is to mint a token of the admitted class with the provider's own tooling | 400 |
| `provideraccount.credential_seal_refused` | The [ADR-021](../../decisions/021-cli-identity-key-storage-custody.md) custody ladder refused on this host — no OS keystore passed its write-probe-read-delete verification and the encrypted-file tier could not be established — so registration refuses rather than degrading to a plaintext write. Distinct from `token_class_refused` because the remedy is a host fix, not a different token | 503 |
| `provideraccount.provider_version_below_floor` | The installed provider binary is older than the release that honors this plane's reserved credential-home variables, or — for the token class — older than a release whose refresh-token absence has been first-party re-verified. Refused fail-closed rather than spawned, because a binary that ignores the pin would silently authenticate against the operator's real home. The payload names the provider, the observed version, and the required floor, so the client can route the operator to an upgrade rather than to re-authentication. | 409 |

### Sidekick Definitions

Sidekick-definition and peer-invocation refusals (Plan-027; [Spec-027](../../specs/027-sidekick-definitions-and-peer-invocation.md)). Every code below is a **fail-closed** refusal: the daemon never substitutes a nearest-match model, a neighbouring effort level, or a default provider account for one a definition pins, because silently running something other than what the definition names changes both behavior and price (`Spec-027 §Fallback Behavior`). Definition mutation is node-local configuration, so these refusals emit no session event.

**The five rows below are the closed set, and they are the _definition-plane_ set.** Peer invocation mints no code at all: `Spec-027 §Required Behavior` requires every peer-invocation refusal to be answered on the callback-tool result's own `denied` / `failed` arms, so an invoke-time authorization denial, an unknown target, and a depth refusal each reach the asking model as a tool result rather than as a JSON-RPC error. `sidekick.permission_denied` is therefore scoped to this namespace's own manage-authority gate and never appears on an invocation.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `sidekick.definition_not_found` | No definition with the given `definitionId` exists on this node — from a `sidekick.*` mutation or from attach-by-reference. **Never from a peer invocation**: an invocation naming an unknown definition answers on the callback-tool result's `failed` arm, per the closed-set paragraph above (`data.fields`: `definitionId`) | 404 |
| `sidekick.definition_name_conflict` | Requested definition name already exists, compared case-insensitively under full Unicode case folding (`Spec-027 §Required Behavior`; `data.fields`: `name`, `existingDefinitionId`) | 409 |
| `sidekick.definition_unreadable` | The definition registry could not be read; attach-by-reference refuses while inline `agent.attach` is unaffected, so a storage fault on this table never blocks ordinary session work (`data.fields`: none) | 503 |
| `sidekick.resolution_refused` | The definition exists but cannot currently produce a runnable agent. `data.fields.reason` is a **closed** discriminator — `model_unavailable` \| `effort_unsupported` \| `account_unavailable` \| `allowlist_unrealizable` — carrying the naming field its arm needs (`modelId`, or `effort` plus the supported `effortLevels`, or `providerAccountId`, or the unrealizable `toolNames` plus the driver's `supportedToolNames`). The fourth arm is not optional: `Spec-027 §Required Behavior` requires the allowlist to be **enforced at spawn** rather than merely recorded, so an allowlist the resolved driver cannot realize must refuse here — an allowlist that is stored and not applied reports a restriction that does not hold. One code rather than four because the caller's situation and remedy are identical in every arm (edit the definition, or repair the account), while `reason` carries what to tell the operator. **There is deliberately no account-_readiness_ arm**: `account_unavailable` fires on registry membership, a definite fact the resolver owns, while authentication state is settled at spawn by I-026-3's live probe and `Spec-026 §Node provider readiness and the sign-in handoff` makes the stored readiness projection advisory only against that gate — so a resolution-time refusal read off the stored projection would refuse an attach the spawn gate would have admitted (`data.fields`: `definitionId`, `reason`, plus the arm's naming field(s) — one on `model_unavailable` and on `account_unavailable`, two on `effort_unsupported` (`effort` plus the supported `effortLevels`) and two on `allowlist_unrealizable` (the unrealizable `toolNames` plus the driver's `supportedToolNames`), each pair naming what was asked for beside what is available because neither alone tells the operator what to edit) | 409 |
| `sidekick.permission_denied` | Cedar denied `Action::"sidekick::manage"` for this principal on the action's own resource descriptor: the **node-scoped** descriptor for a definition mutation, which is node-global and carries no `sessionId`, or the named **session** for turning peer invocation on. Invocation-time denial of `Action::"sidekick::invoke"` is **not** this code: it rides the callback-tool result's `denied` arm naming the action (`Spec-010 §Implementation Notes`; `data.fields`: `action`) | 403 |

### MCP Governance

| Code | Description | HTTP Status |
| --- | --- | --- |
| `mcp.server_not_found` | No server with the requested `(provider, scope, scopeRef, serverName)` binding exists in the unified inventory — identity is per-provider and per-scope, so a same-named server on the other provider or in another scope does not match (`Spec-025 §Unified Inventory`, campaign B18) | 404 |
| `mcp.config_invalid` | The submitted server configuration failed validation — malformed shape, unknown transport, or any refusal detectable **before the durable leg commits**; strictly pre-commit by contract: once the durable write has landed, per-leg live-application failures (including Claude `setMcpServers` per-server errors) report as `liveResults[]` entries on the successful response, never as this error, so a caller is never induced to retry a committed mutation (`Spec-025 §Configuration Mutation`, campaign B18) | 400 |
| `mcp.config_write_conflict` | Codex user-scope config write failed optimistic concurrency twice — the `expected_version` write and the single silent re-read-and-retry both hit `configVersionConflict`; the error carries both version tokens so the caller can re-inspect (`Spec-025 §Fallback Behavior`, campaign B18) | 409 |
| `mcp.idempotency_conflict` | A governance mutation's `clientIdempotencyKey` was reused with a differing request digest; the original mutation and its receipt are untouched and the conflicting request is refused — an identical retry instead replays the recorded response with no provider call, store write, or second event (`Spec-025 §Authorization`, campaign B18; the `intervention.idempotency_conflict` precedent) | 409 |
| `mcp.config_scope_unsupported` | The operation requires a mechanism the target binding's scope cannot support in V1 — a provider-config write at a non-`user` scope (Codex project-local `.codex/config.toml` and Claude `.mcp.json` / `local`-scope entries are read-only), a governance mutation on a binding V1 never materializes into runs (Claude project/local), or a native-write-only override facet (`enabled`/`approvalMode`) on a Codex `project` binding; guidance names the file to edit, in the message only, never in event payloads (`Spec-025 §Configuration Mutation`, campaign B18) | 400 |
| `mcp.operator_scope_required` | The caller does not own this node — governance is node-owner authority under the caller-owns-the-node model, and a caller who fails that predicate is refused outright, never queued. The predicate is **ownership, never transport origin**: the owner reaches this plane identically from the machine itself and from any linked device, so this code never fires on the strength of which transport carried the call (`Spec-025 §Authorization`, campaign B18; `Spec-028 §Parity by construction`) | 403 |
| `mcp.governance_denied` | Cedar denied the governance mutation under the `mcp` action family; authorization is evaluated before existence checks so the refusal is stable and does not leak inventory contents (`Spec-025 §Authorization`, campaign B18) | 403 |
| `mcp.trust_required` | A safety-weakening tool override — idempotency-class assignment off the `manual_reconcile_only` floor, an approval mode weaker than the provider default, or `enabled: true` (broadening the executable tool set) — was attempted on an untrusted server (`Spec-025 §Trust Governance`, campaign B18) | 403 |
| `mcp.oauth_flow_failed` | The provider failed to **launch** its OAuth flow — a provider-side error on the still-open `mcp.oauthLogin` call; strictly launch-phase: once the call has returned, an asynchronous completion failure is delivered as the `mcp.server_oauth_completed` event with `outcome: 'failure'` (observable on the `mcp.subscribe` stream), never as a late error on a completed call; the message never carries authorization URLs or credential material (`Spec-025 §OAuth Orchestration`, campaign B18) | 502 |
| `mcp.oauth_unsupported` | The provider cannot run the OAuth flow in-band in the current mode (Claude non-interactive); guidance names the out-of-band login command and the server's `needs-auth` status remains the visible state (`Spec-025 §OAuth Orchestration`, campaign B18) | 400 |

### Relay

| Code | Description | HTTP Status |
| --- | --- | --- |
| `relay.connection_failed` | Relay connection to the upstream service failed | 502 |
| `relay.group_full` | The session already has as many of the user's devices attached to its relay as it admits at once — a per-session **device-connection** cap, never a limit on people, since a session belongs to one user and admits no second account. Revoking or disconnecting a device frees a slot | 429 |
| `relay.authentication_failed` | Relay authentication failed | 401 |
| `relay.bundle_rejected` | Relay `SessionKeyBundle` admission rejected — the bundle's Ed25519 identity is not bound to a registered device (Plan-028). Distinct from the handshake-scoped `relay.authentication_failed`. | 403 |
| `relay.replay_rejected` | Relay frame rejected — the AEAD-bound sender sequence is ≤ the last accepted sequence for that sender (monotonic-seq replay; client-side detection per Plan-028) | 409 |
| `relay.bundle_signature_invalid` | Peer `SessionKeyBundle` rejected on client-side defense-in-depth re-verification — the Ed25519 signature over `session_id ‖ ephemeral_x25519_public` failed (Plan-028) | 403 |

### Transport

Wire-level codes describing peer mis-use of the framing/handshake layer. Distinct from §Resource (which describes domain-level quota saturation): a transport failure is a peer behaving incorrectly toward the protocol substrate, not a session/run quota refusing additional creates.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `transport.unavailable` | Requested transport (e.g. loopback fallback) is not enabled for this daemon process per its conservative-default gate (Plan-006 F-006p-2-09) | 503 |
| `transport.message_too_large` | Inbound frame's declared body length exceeded the 1MB cap, or daemon-side outbound build exceeded it (Plan-006 F-006p-2-05/F-006p-2-11). 413 semantic. | 413 |
| `transport.invalid_protocol_version` | Per-request envelope-level `protocolVersion` field violates `Spec-006 §Wire Format` (BL-102 ratification): the field is missing, the wrong JS type, or fails the ISO 8601 `YYYY-MM-DD` shape. Substrate-side gate; fires BEFORE handler dispatch (I-006-7). Distinct from `version.floor_exceeded` / `version.ceiling_exceeded` (registry-side handshake-incompatibility) and from `protocol.version_mismatch` (registry-side mutating-op gate after handshake declared incompatible). 400 semantic. | 400 |

### Resource

| Code                      | Description                     | HTTP Status |
| ------------------------- | ------------------------------- | ----------- |
| `resource.limit_exceeded` | General resource limit exceeded | 429         |

### System

| Code                    | Description                      | HTTP Status |
| ----------------------- | -------------------------------- | ----------- |
| `system.internal_error` | Unexpected internal error        | 500         |
| `system.maintenance`    | System is undergoing maintenance | 503         |

### GDPR

Daemon-local data-subject-request codes (Plan-020). The V1.1 erasure / export / purge handlers are daemon-bound — they read daemon-local `user_keys` + the `sodium_mlock`-held master key, which the Cloudflare-Workers control plane cannot reach — so these codes ride the **daemon JSON-RPC wire only**: the HTTP status below is notional, and the numeric discriminator is pinned in [§JSON-RPC Wire Mapping → §Plan-020 Tier 4 Domain Identifiers](#plan-020-tier-4-domain-identifiers).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `gdpr.endpoint_not_v1` | A `gdpr.*` data-subject endpoint (session purge / user export / user delete) was invoked in V1; the registered daemon stub returns the not-implemented envelope unconditionally, reserving the namespace for the V1.1 handler (Plan-020 D-020-3 / I-020-17) | 501 |

### Admin

Operator admin-surface codes (Plan-019 admin-bans API, [D-019-1](../../plans/019-rate-limiting-policy.md#ratified-design-decisions-tier-5-audit)). The surface authenticates via the deployment's operator admin token; an absent or malformed credential maps to the existing `auth.token_invalid` row (401) — no admin-namespace auth code exists.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `admin.forbidden` | Operator admin token present but mismatched on the admin-bans surface (constant-time compare failed) | 403 |
| `admin.ban_not_found` | `DELETE /admin/bans/:id` targeted a missing or already-revoked ban (revoke is not idempotent) | 404 |
| `admin.ban_already_exists` | Losing side of the one-active-ban race: an **active** (non-revoked, non-expired) ban already exists for `(identity, identity_type)` (Postgres `23505` on the partial unique index, I-019-6). An expired-but-unrevoked standing ban does not refuse — the issue path supersedes it (atomic revoke-then-insert, Plan-019 D-019-12) | 409 |

### Version

Cross-version compatibility errors per [ADR-018](../../decisions/018-cross-version-compatibility.md) §Decision #4. These errors fire when a client, daemon, or event envelope declares a version outside the accepted range for the session or the platform. The wire/persisted envelope version is a semver `MAJOR.MINOR` string per `ADR-018 §Decision` #1 — numeric form is rejected at validation. Typed error names (`VERSION_FLOOR_EXCEEDED`, `VERSION_CEILING_EXCEEDED`) from ADR-018 map to the dotted registry codes below.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `version.floor_exceeded` | Client attach or event envelope version is below the session's `min_client_version` floor per [ADR-018](../../decisions/018-cross-version-compatibility.md) §Decision #3 / §Decision #4 (typed: `VERSION_FLOOR_EXCEEDED`; the bound-checked version is the branded `EventEnvelopeVersion` — validated by `packages/contracts/src/event.ts#EventEnvelopeVersionSchema` per `Spec-005 §EventEnvelope Version Semantics`) | 409 |
| `version.ceiling_exceeded` | Event envelope version exceeds the maximum supported by the reading party per `ADR-018 §Decision` #10 (typed: `VERSION_CEILING_EXCEEDED`; same branded comparand — `packages/contracts/src/event.ts#EventEnvelopeVersionSchema`, `Spec-005 §EventEnvelope Version Semantics`) | 409 |

`version.floor_exceeded` is **surface-polymorphic** — the same wire code carries a different shape on each of its two emitting surfaces:

1. **JSON-RPC daemon handshake** (version negotiation, [Spec-006](../../specs/006-local-ipc-and-daemon-control.md)): it is a `DaemonHelloAck.reason` discriminator **string** — _not_ a `details` payload (see [§Negotiation Refusals](#negotiation-refusals), where the row is `n/a (DaemonHelloAck.reason field)`). The handshake's structured detail, when present, rides the separate JSON-RPC `data.fields` channel of the [two-layer envelope](#two-layer-envelope-shape).
2. **Control-plane runtime-node write-refusal** ([Spec-002 §Required Behavior](../../specs/002-runtime-node-attach.md#required-behavior) / [ADR-018](../../decisions/018-cross-version-compatibility.md) §Decision #4 — a below-floor node admitted read-only at attach is refused on its later version-sensitive domain write — a capability declaration, or from Plan-005 T4.10 a signing-key registration): it is **code+message-only**. The session floor is one-sided (`sessions.min_client_version`, with no `max` anywhere), so the two-sided `VersionBoundExceededDetails` schema cannot be populated; the daemon already learned its read-only verdict at attach; and the `message` carries leak-free upgrade context (the node id, the daemon's declared client version, and the session floor).

The canonical `ErrorResponse` envelope makes `details` optional, so surface (2)'s code+message-only form is a valid `ErrorResponse`.

### Event

Event-replay cursor errors (Plan-005). Like the §Run / §Queue namespaces these ride the daemon JSON-RPC wire with the dotted code as the canonical `data.type` identifier; the HTTP status is the control-plane-notional mapping.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `event.cursor_unresolvable` | An `EventCursor` submitted to `readAfterCursor` / `readWindow` cannot be decoded to a log position — `decodeEventCursor` rejects a non-integer or a value `< -1` (a legacy SDK-synthesized UUID, a corrupted cursor) under the Plan-005 T4.3 predecessor-position cursor model (typed: `CURSOR_UNRESOLVABLE`) | 400 |

### Daemon

Daemon-local write-path refusals (Plan-005). Like §Event these ride the daemon JSON-RPC wire with the dotted code as the canonical `data.type` identifier; the HTTP status is the control-plane-notional mapping. Registered by the Plan-005 T3.1-seam targeted readiness-audit delta (F-005-HALT-03, PR #282, 2026-08-02).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `daemon.ingest_halted` | `EventLogService.append` refuses a session whose ingest is administratively halted — the T4.2 key-reuse observer published `halt(sessionId)` through T3.1's `IngestHaltRegistry` and the collision persists in the key stores; carries the refused `sessionId` (`data.fields`: `sessionId`, typed `DaemonIngestHaltedDetailsSchema`); re-admission only via `clear(sessionId)` when the collision leaves the observable set (Plan-005 T3.1 / I-005-4-03; typed: `DAEMON_INGEST_HALTED_CODE`; a state-dependent refusal of an otherwise-valid write, hence 409 — the `run.invalid_transition` / `channel.inactive` / `agent.not_ready` state-refusal shape) | 409 |
| `daemon.pii_split_bypass` | `EventLogService.append` refuses a write whose `payload` carries a PII-tagged field with no `pii_ciphertext_digest` — the write bypassed the T2.4 `pii-indirection.ts` sole-write-path split; a hard write-path rejection, structurally invalid regardless of session state, unlike the state-dependent `daemon.ingest_halted` (Plan-005 T3.1; typed: `DAEMON_PII_SPLIT_BYPASS_CODE`; `data.fields`: `fieldPath` — the offending field's payload key path, never its value — typed `DaemonPiiSplitBypassDetailsSchema`; the write-path-refusal sibling the ingest-halt clause cites as precedent — the typed wire error, distinct from the `daemon.pii_split_ambiguous` taxonomy event — that event signals a SUCCESSFUL containment fallback, an ambiguous record routed wholesale into `pii_payload`, never a failed write; the Spec-005 census row draws exactly that distinction rather than characterizing this rejection) | 400 |
| `daemon.event_canonical_bytes_exceeded` | `EventLogService.append` refuses a write whose `canonical_bytes(row)` exceeds `EVENT_CANONICAL_BYTES_MAX` = 32 KiB ([Spec-005 §Canonical Serialization Rules](../../specs/005-session-event-taxonomy-and-audit-log.md#canonical-serialization-rules), 2026-08-11 amendment) — the payload-design bound that keeps a single row's canonical form small enough to carry, sign, and re-read cheaply; a hard write-path rejection of the `daemon.pii_split_bypass` class, structurally invalid regardless of session state — refused before any row is written, never truncated (registered 2026-08-11, Codex PR #323 round 2; the code constant and enforcement landed 2026-08-12 with the Plan-005 follow-up code PR the Spec-005 bullet names, PR #324) | 400 |

---

## Rate Limiting

Standard 429 response shape (from API Payload Contracts):

```ts
interface RateLimitResponse {
  code: "rate_limited";
  retryAfter?: number; // seconds until retry is allowed — sliding-window/escalation refusals; omitted on concurrency-cap refusals (capacity frees on release; no reset clock — Spec-019 §Overflow Response)
  limit: number; // total allowed requests in the window (the cap itself on concurrency-cap refusals)
  remaining: number; // requests remaining in the current window
  resetAt?: string; // ISO 8601 timestamp when the limit resets — same enforcement-class rule as retryAfter
}
```

All rate-limited endpoints return the `RateLimitResponse` envelope with HTTP status 429. The `resetAt` field provides the absolute timestamp (ISO 8601) when the rate limit window resets, complementing the relative `retryAfter` seconds value. The timing pair is enforcement-class-conditional (`Spec-019 §Overflow Response`): sliding-window and escalation refusals carry both; concurrency-cap refusals omit both fields and the `Retry-After`/`X-RateLimit-Reset` headers — cap capacity frees when an existing holder releases, not at a known timestamp.

Rate limit error codes that trigger this response:

- `session.limit_exceeded`
- `run.limit_exceeded`
- `relay.group_full`
- `resource.limit_exceeded`

Enforcement-layer codes outside the 429 envelope (Plan-019, Tier-5 audit). These use the standard `ErrorResponse` envelope, not `RateLimitResponse`:

| Code | Description | HTTP Status |
| --- | --- | --- |
| `ratelimit.banned` | Request refused because an active admin ban matches the caller identity; terminal — no counter capacity consumed (admission order ban → block → counter, Plan-019 I-019-1) | 403 |
| `ratelimit.backend_unavailable` | Rate-limit backend unreachable past the fail-open grace window (`AIS_RATELIMIT_FAILOPEN_SECONDS`); enforcement fails closed | 503 |
