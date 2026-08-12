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

**HTTP status overrides (2026-08-11, Spec-002 BL-133 amendment).** Most control-plane refusals map to tRPC's default status for their error kind (400/401/403/404/409/429). Where a code **served over control-plane tRPC** has a table row pinning a status the defaults cannot express — at this amendment, the two **410 Gone** invite rows, `invite.expired` and `invite.revoked` — the pin is enforced by a contracts-level map, `AIS_WIRE_HTTP_STATUS_OVERRIDES` (`packages/contracts/src/error.ts`, landing with Plan-002 T2.6): the control-plane `errorFormatter` stamps the mapped status onto `data.httpStatus`, and the tRPC fetch transport lifts it natively via `getHTTPStatusCode` — no `responseMeta` hook, and a mixed-status batch degrades to **207 Multi-Status** per tRPC's own batching rule. The map is the single registration point: a future code whose table row pins a non-default status registers there rather than minting a transport hook (`artifact.relay_expired`'s 410 row joins when Plan-014 Tasks 7–10 build its tRPC surface; `approval.request_expired`'s 410 row joins only if it ever gains a control-plane tRPC surface — its V1 surface is daemon-side JSON-RPC, where §JSON-RPC Wire Mapping applies instead).

---

## JSON-RPC Wire Mapping

Local IPC traffic (Plan-007 daemon ↔ in-tree clients) frames errors per [JSON-RPC 2.0 §5.1](https://www.jsonrpc.org/specification#error_object), which structurally requires `code` to be a Number. The dotted-namespace identifier (the canonical project code in §Error Codes below) rides in `data.type` per the [RFC 7807 Problem Details](https://datatracker.ietf.org/doc/html/rfc7807) precedent for structured error responses and the [LSP 3.17 ResponseError](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#responseError) field convention. This section closes BL-103 and the BLOCKED-ON-C7 markers in Plan-007 Phase 2.

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
  readonly message: string; // human-readable; sanitized at I-007-8 boundary (no stack/secret leak)
  readonly data?: {
    readonly type: string; // dotted-namespace project code (e.g. "session.not_found")
    readonly fields?: Record<string, unknown>;
    // structured detail (e.g. { setting: "max_workers", value: -1 })
  };
}
```

The numeric `code` is the JSON-RPC spec-mandated discriminator. The `data.type` is the canonical project code — the same dotted-namespace strings the §Error Codes tables register. Consumers MUST discriminate on `data.type` (not on `message`) for project-level error handling; `code` is for JSON-RPC-level discrimination only.

`data.fields` is optional structured detail. Producers MUST keep it free of sensitive content (no stack traces, no absolute paths, no secrets) per Plan-007 invariant I-007-8. The daemon's `mapJsonRpcError` substrate enforces I-007-8 a second time on the `data.fields` channel as defense-in-depth: every value passes through `sanitizeFields` (path redaction, length cap, JSON-unsafe value sentinels — `BigInt` / `NaN` / `Infinity` / `Symbol` / `Function` / circular references / hostile getters — and width / depth / node-count caps) before the envelope is serialized. Producer discipline remains primary; the substrate is the safety net that survives a future builder forgetting to redact.

### Plan-007 Tier 1 Domain Identifiers

| `data.type` | JSON-RPC `code` | Trigger |
| --- | --- | --- |
| `unknown_setting` | `-32602` | Bootstrap rejected an unrecognized SecureDefaults config key (per F-007p-1-2 + T-007p-1-4) |
| `transport.unavailable` | `-32603` | Loopback-fallback transport requested without operator opt-in (per F-007p-2-09 Tier 1 conservative gate) |
| `transport.message_too_large` | `-32600` | Inbound frame exceeded the 1MB body cap (per F-007p-2-05; the spec-required InvalidRequest classification per `Plan-007 §Phase 2: Wire Substrate` (T-007p-2-2) mapping). Distinct from Spec-001's `resource.limit_exceeded` (HTTP-429 domain quota saturation): a 413-semantic peer mis-framing of the wire layer. |
| `transport.invalid_protocol_version` | `-32600` | Per-request envelope-level `protocolVersion` field violates `Spec-007 §Wire Format` (BL-102 ratified): missing, wrong type, or fails the ISO 8601 `YYYY-MM-DD` shape. The substrate `dispatchFrame` gate in `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts#LocalIpcGateway` enforces per I-007-7 BEFORE handler dispatch; the handshake (`daemon.hello`) is exempt because the negotiation parameter rides in `params.protocolVersion`. Distinct from `protocol.version_mismatch` (NegotiationError, registry-side gate for incompatible negotiated versions on subsequent mutating ops): the wire-layer envelope shape gate fires once-per-frame, the registry-side gate fires once-per-incompatible-mutating-op. |

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
| `protocol.handshake_required` | `-32600` | NegotiationError | Mutating dispatch attempted in `pre` state (I-007-1) |
| `protocol.version_mismatch` | `-32600` | NegotiationError | Mutating dispatch attempted in `done-incompatible` state (`Spec-007 §Fallback Behavior`) |

### Plan-022 Tier 5 Domain Identifiers

The `gdpr.*` stub methods are registered daemon JSON-RPC handlers (Plan-022 D-022-3) that return the not-implemented envelope unconditionally. Per [§Numeric Code Space](#numeric-code-space-per-json-rpc-20-51) the project mints **no** custom numeric domain codes — the stub rides the standard `-32603` discriminator with its project code in `data.type`, exactly mirroring `transport.unavailable` (a registered handler deliberately unavailable in this configuration). Consumers discriminate on `data.type`, never on the coarse `-32603` (a bare `-32603` with no `data.type` remains a genuine internal error).

| `data.type` | JSON-RPC `code` | Trigger |
| --- | --- | --- |
| `gdpr.endpoint_not_v1` | `-32603` | A registered `gdpr.*` daemon stub (`gdpr.sessionPurge` / `gdpr.participantExport` / `gdpr.participantDelete`) was invoked in V1; the handler returns the not-implemented envelope unconditionally (Plan-022 I-022-17). Notional HTTP 501 in [§Error Codes → §GDPR](#gdpr). |

### Test-Side Discrimination

Test code asserting on JSON-RPC error envelopes MUST discriminate on `data.type` for project-level expectations and on `code` for JSON-RPC-level expectations. The pre-BL-103 substrate's code-string-only assertion (T-007p-1-4 unknown_setting test) widens to full-envelope-shape assertion as part of BL-103 closure:

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
| `session.goal_delivery_failed` | A live-leg goal mutation (`session.goalUpdate` / `session.goalClear`) failed at the provider driver — no event appended, no goal change; acked legs reverted to the prior goal (`Spec-016 §Session Goals`, campaign B6; `data.fields`: `failedBindingIds`, `driverCode`) | 502 |
| `session.goal_mutation_in_flight` | A goal mutation was refused because a prior goal intent has not converged — whether still applying (legs `pending`/`acked`; the ordinary concurrent-update case) or compensating after a failure (an `acked` leg awaiting revert) — retry after convergence (`Spec-016 §Session Goals`, campaign B6; `data.fields`: `unconvergedBindingIds` — every not-yet-converged leg, any state) | 409 |
| `session.history_backfill_unavailable` | A peer history backfill source refuses the request at response level — a transient serving-side refusal, never the coverage state itself: the requester keeps its two-axis `pending_backfill` degraded state and re-requests on retry, restart, or presence transition, converging idempotently on canonical `id`s under first-delivery-wins (`Spec-008 §Peer History Backfill On Join (V1)`; registered by Plan-008's R4 backfill task T-008r-4-14 per the OD-008r-1 registration shape) | 503 |

### Auth

| Code | Description | HTTP Status |
| --- | --- | --- |
| `auth.token_expired` | Authentication token has expired | 401 |
| `auth.token_invalid` | Authentication token is malformed or invalid | 401 |
| `auth.insufficient_scope` | Token does not have the required scope for this operation | 403 |
| `auth.dpop_mismatch` | DPoP proof does not match the bound token | 401 |
| `auth.principal_mismatch` | Body-supplied actor field (e.g. `approver`, `inviter`, `initiatorId`) disagrees with the verified PASETO `sub` claim; see [api-payload-contracts §Authenticated Principal And Authorization Model](./api-payload-contracts.md#authenticated-principal-and-authorization-model) | 403 |

### Run

| Code | Description | HTTP Status |
| --- | --- | --- |
| `run.invalid_transition` | Requested state transition is not allowed from the current run state | 409 |
| `run.not_found` | Run does not exist or is not accessible | 404 |
| `run.limit_exceeded` | Concurrent run limit exceeded | 429 |
| `run.recovery_failed` | Run recovery failed due to an internal error | 500 |
| `run.execution_root_released` | `run.resume` against a rolled-back run re-opened conversation-only whose execution context is released with no existing root (a disposed ephemeral clone / a retired worktree — nothing recreates it); run state unchanged. Plan-004 rollback extension; distinct from the setup-time `workspace.execution_root_unresolved` | 409 |

### Queue

Daemon-local run-queue control codes (Plan-004). Run-control authority is daemon-only ([ADR-003](../../decisions/003-daemon-backed-queue-and-interventions.md)), so — like the §Run namespace — these ride the daemon JSON-RPC wire with the dotted code as the canonical `data.type` identifier and the HTTP status as the control-plane-notional mapping; no separate §JSON-RPC numeric pin (the §Run domain-code convention).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `queue.persistence_unavailable` | New queued run-control work was rejected fail-closed because the daemon's queue-persistence layer is unavailable (Plan-004 I-004-1 / ADR-003 — block new queued work when persistence is unavailable) | 503 |

### Intervention

Intervention request-admission codes ([Spec-005 §Required Behavior](../../specs/005-provider-driver-contract-and-capabilities.md#required-behavior), campaign B3). Intervention **outcomes** deliberately resolve via the six-state lifecycle (`rejected` / `expired` / `degraded` are states, not error codes — [queue-and-intervention-model.md §Driver Result To Lifecycle Mapping](../../domain/queue-and-intervention-model.md#driver-result-to-lifecycle-mapping)); this namespace covers only request-level refusals that never produce an intervention row. The token deliberately collides with no `intervention.*` durable event name (`requested`/`accepted`/`applied`/`rejected`/`degraded`/`expired` — the never-collide rule, D-012-4 convention).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `intervention.idempotency_conflict` | A `clientIdempotencyKey` was reused with a differing payload; the original intervention is untouched and the conflicting request is refused (an identical retry is not an error — it replays the recorded outcome). Semantic payload conflict per the converging idempotency-key practice (`data.fields`: `targetRunId`, `interventionId` of the original) | 422 |

### Channel

Channel lifecycle codes (Plan-016, Tier-6 audit D-016-16). Daemon-only authority — same wire convention as §Run/§Queue (dotted code as `data.type`, HTTP status as control-plane-notional mapping). Code tokens deliberately avoid the Spec-006 event names `channel.created`/`channel.muted`/`channel.unmuted`/`channel.archived` (never-collide rule, D-012-4).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `channel.not_found` | Channel does not exist in the session (`data.fields`: `channelId`) | 404 |
| `channel.inactive` | Target channel is archived (terminal) and cannot admit new runs or lifecycle mutations; muted channels still admit — mute suppresses attention surfaces, not execution (D-016-12; `data.fields`: `channelId`, `state`) | 409 |
| `channel.name_reserved` | Requested channel name collides with the reserved bootstrap `main` channel name (`data.fields`: `name`) | 409 |

### Orchestration

Orchestration admission-refusal codes (Plan-016, Tier-6 audit D-016-16). Every code is a zero-residue create-time refusal — no run row, no queue item, no partial state survives the rejection (I-016-8); the daemon additionally records the refusal durably via the `orchestration.rejected` event (`Spec-016 §Example Flows` "records the refusal visibly"). The event name `orchestration.rejected` and these error codes share a root but no token collides with an event name. The parent-run-missing case reuses §Run `run.not_found` (no new semantic — D-016-16).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `orchestration.depth_exceeded` | Creating run is itself a child — V1 permits exactly one level of run nesting (`Spec-016 §Default Behavior`; `data.fields`: `parentRunId`, `maxDepth: 1`) | 409 |
| `orchestration.active_child_limit_exceeded` | Parent already has the configured number of active children (`data.fields`: `parentRunId`, `limit`, `activeChildCount`) | 429 |
| `orchestration.pending_limit_exceeded` | Session already has the maximum pending orchestration-created runs (`Spec-016 §Scheduler Limits`; `data.fields`: `limit`) | 429 |
| `orchestration.channel_limit_exceeded` | Admitting the run would open a new executing channel beyond the maximum concurrently executing channels (`Spec-016 §Scheduler Limits`; `data.fields`: `limit`) — the run may instead be held `queued`; this code fires only when the target channel's queue is also exhausted (a busy target channel with a full queue is `orchestration.queue_depth_exceeded` regardless of the executing-channel count) | 429 |
| `orchestration.queue_depth_exceeded` | Target channel already has an executing run and its queue is at maximum depth, so the run cannot be held `queued` (`Spec-016 §Scheduler Limits`: 25 per channel, subject to the Spec-001 per-session queue depth; `data.fields`: `channelId`, `limit`, `queuedCount`) | 429 |
| `orchestration.turn_limit_exceeded` | Target agent is at its consecutive-turn limit in the target channel (D-016-8 — the counter resets on an interleaving human or different-agent turn; `data.fields`: `agentId`, `channelId`, `limit`) | 429 |
| `orchestration.budget_exhausted` | Session cost ceiling reached — admission blocked until the session owner raises the limit; also fired for the unpriced-model-family admission block with `reason: 'unpriced-model'` + `modelFamily` in `data.fields` and the same threshold fields carrying the configured limit + committed spend (observed cost including unpriced terminal debits, plus active reservations), and for native-cap-escape reservation refusals — `reason: 'driver_capless'` when the target leg's driver lacks the `cost_cap` capability (fail-closed, Spec-005 matrix) — where `observedValue` carries committed spend (observed cost including unpriced terminal debits, plus active reservations) (`Spec-016 §Budget Policies` incl. §Cost Derivation And Absent-Cost Semantics, campaign B6; `data.fields`: `budgetType`, `limitValue`, `observedValue`, `reason?`, `modelFamily?`) | 429 |
| `orchestration.node_not_local` | `targetNodeId` names a node not attached to this daemon — V1 orchestration is single-node; cross-node dispatch is Spec-024/Plan-027 (D-016-9; `data.fields`: `targetNodeId`) | 422 |

### Agent

Agent-surface codes (Plan-016, Tier-6 audit A-016-2 / D-016-16).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `agent.not_found` | Agent does not exist in the session (`data.fields`: `agentId`) | 404 |
| `agent.not_ready` | Agent is not in the `ready` lifecycle state (`configured` / `disabled` / `archived` per [agent-channel-and-run-model.md §Lifecycle](../../domain/agent-channel-and-run-model.md#lifecycle)) or its driver is unavailable, so it cannot take a run (`data.fields`: `agentId`, `state`) | 409 |

### Approval

| Code | Description | HTTP Status |
| --- | --- | --- |
| `approval.not_found` | Approval request does not exist | 404 |
| `approval.already_resolved` | Approval request has already been resolved | 409 |
| `approval.request_expired` | Approval request has expired and can no longer be resolved | 410 |
| `approval.request_canceled` | Approval request was canceled (its run ended, its session closed, or its originating provider ask was retracted before resolution — Plan-012 T2.8's live-leg cancel ingress, campaign B13) and can no longer be resolved; also the late-CREATE refusal — a create arriving for an already-ended run or already-closed session (Plan-012 T2.12, campaign B13). The **late-CREATE refusal shape** carries a typed `reason` extension member — `'run_ended' \| 'session_closed'` — per RFC 9457 §3.2 extension-member practice, derived from live terminal state at refusal time (a retraction can never cause a late CREATE — the request already exists when a retraction settles it); the resolve-path 409 for an already-canceled request carries no `reason` (the cancellation cause is not persisted on `approval.canceled` — audit reconstructs it from the adjacent run/session terminal rows on the timeline, or for a retraction from the paired `driver_ask.canceled` row carrying the same `askId`) | 409 |
| `approval.persistence_unavailable` | A permission check or approval mutation was rejected fail-closed because the daemon's approval-persistence layer is unavailable (`Spec-012 §Fallback Behavior` — the sensitive action must not proceed) | 503 |
| `approval.policy_artifact_corrupt` | A content-addressed credential-policy / execution-posture artifact failed its read-boundary integrity check — the stored `artifact` bytes no longer re-hash to the row's `ref` (Plan-012 T2.9, campaign B13); the read fails closed and the consuming run takes `Spec-012 §Fallback Behavior`'s strict per-request posture, never the unverifiable policy | 500 |
| `approval.rule_not_found` | Remembered approval rule does not exist | 404 |
| `approval.rule_already_revoked` | Remembered approval rule has already been revoked | 409 |

The `approval.request_expired` / `approval.request_canceled` tokens deliberately differ from the Spec-006 durable event names `approval.expired` / `approval.canceled` so an error code never collides with an event name (the same never-collide rule the `runtimenode` namespace documents below; Tier-6 audit, D-012-4). No `approval.permission_denied` code exists in V1: the daemon IPC surface carries no caller principal (api-payload-contracts §Authenticated Principal, local-daemon endpoints), `PermissionCheck` denial is a normal `allowed: false` response rather than an error, and cross-participant approval authorization is structurally absent until Plan-027 (Spec-024) — minting one is Plan-027's call. The B13 `approval.policy_artifact_corrupt` row deliberately does not reuse `artifact.hash_mismatch`: that code names Spec-014's file-artifact domain and its 409 a fetch-time conflict, while this failure is server-side stored-state corruption in the approval trust store (500) — family prefixes route by domain.

### Invite

| Code                       | Description                                        | HTTP Status |
| -------------------------- | -------------------------------------------------- | ----------- |
| `invite.not_found`         | Invite does not exist                              | 404         |
| `invite.already_accepted`  | Invite has already been accepted                   | 409         |
| `invite.expired`           | Invite has expired and can no longer be accepted   | 410         |
| `invite.revoked`           | Invite has been revoked by the issuer              | 410         |
| `invite.limit_exceeded`    | Invite creation rate limit exceeded                | 429         |
| `invite.permission_denied` | Only the session owner may issue or revoke invites | 403         |

### Membership

| Code | Description | HTTP Status |
| --- | --- | --- |
| `membership.not_found` | Membership does not exist | 404 |
| `membership.permission_denied` | Actor is not permitted to apply the requested membership change (owner-only) | 403 |
| `membership.last_owner` | Action would remove the last remaining active owner of the session | 409 |

### Presence

| Code | Description | HTTP Status |
| --- | --- | --- |
| `presence.permission_denied` | Actor is not in the authorized set (owner/operator) for per-device presence detail; the aggregated presence summary is the unauthorized-default projection (Plan-018 D-018-5 / I-018-6). Served via the daemon `participant.presenceDetail` gateway — domain authz code, HTTP row per the `membership.permission_denied` convention (no §JSON-RPC pin). | 403 |

### Runtime Node

These codes are registry-only (code + message; no structured `details`): no acceptance criterion needs structured detail, and a conflicting-session-id detail would risk cross-session info-leak. The domain token `runtimenode` matches the method namespace (`runtimenode.attach` / `runtimenode.capabilityupdate`) and deliberately differs from the `runtime_node.*` durable event-name namespace (separator differs) so an error code never collides with an event name.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `runtimenode.attach_conflict` | Runtime node is already actively attached to another session; detach before attaching elsewhere (transient — Plan-003 I-003-5 / T3.2 P9) | 409 |
| `runtimenode.attach_revoked` | Runtime node's attachment to this session was revoked; revocation is terminal (Plan-003 T3.2 P10) | 409 |
| `runtimenode.capabilityupdate_conflict` | Runtime node has no active attachment to refresh, or cannot be brought online via capability update (online requires a daemon-side capability declaration) — coordination-snapshot refresh refused (Plan-003 I-003-2 / T3.9) | 409 |
| `runtimenode.signingkeyregister_conflict` | Signing-key registration presented a key that differs from the stored one for its `(session, node)` pair — register-once, refused before any row write; V1 specifies no daemon signing-key rotation ceremony, so refusal is the rotation policy (Plan-006 T4.10 per CP-006-7 leg B — the control-plane mirror of T4.2 `refuse_on_rotation`) | 409 |
| `runtimenode.permission_denied` | Caller is not authorized for the signing-key surface — on `runtimenode.signingkeyregister`, the caller's verified principal is not an ACTIVE member of the session (inactive or absent membership and a nonexistent session collapse into this one refusal — no membership or session-existence oracle, per this family's no-info-leak header; the membership arm added at round 4; the attachment-ownership and `attachmentId`-equality arms this row carried 2026-08-01–2026-08-11 were deleted by the admission-time registration decoupling along with the delivery machinery that fed them — registration keys on membership admission, and the producer binding is the daemon-bound credential at participant granularity, the widening named at `security-architecture.md §Per-Event Daemon Signature`); on `runtimenode.signingkeyroster`, the caller is not an active member of the session (any active role reads; the membership predicate and the roster read are one SQL statement — one READ COMMITTED snapshot, never reading `sessions` — so non-member and nonexistent-session refusals are byte-identical and no revocation can interleave). One code, two call sites with distinct messages — the `runtimenode.capabilityupdate_conflict` precedent; domain authz code, HTTP row per the `membership.permission_denied` convention; deliberately never tRPC `NOT_FOUND`, which this namespace reserves as the old-control-plane procedure-absence discovery signal (Plan-006 T4.10, Codex PR #274 rounds 3–4, 2026-07-31) | 403 |

### PTY

Shared-terminal write-lease refusals (`Spec-003 §Required Behavior`, campaign B4 2026-07-06). The lease is exclusive per session: exactly one participant holds terminal control at a time, and no holder means writes are refused (fail-closed).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `pty.control_not_held` | Terminal write or `session.releaseControl` attempted without holding the shared-terminal write lease — take control first (null-holder-refuses-writes) | 409 |
| `pty.control_held_by_other` | `session.takeControl` refused: another participant holds the lease; `data.fields.holderParticipantId` names the holder on the JSON-RPC surface, mirrored as `details.holderParticipantId` on the HTTP `ErrorResponse` envelope (same value on both surfaces, via the canonical envelope's structured-context field) — handoff is explicit (holder releases, then take) | 409 |
| `pty.permission_denied` | `session.takeControl` by a role outside the authorized set (owner/collaborator — the Security Architecture permission-matrix 'Take terminal control' row); evaluated before any lease-state comparison — the refusal is role-determined and stable, never varying with mutable lease state (holder identity is session-visible presence metadata via `pty.control_changed` and the roster's `controlHolder`; the ordering is authorization hygiene, not secrecy). `session.releaseControl` is deliberately exempt — release is holder-gated (`pty.control_not_held`), never role-gated: during the authorization-loss propagation window (demotion, suspension, or revocation in flight) the affected holder's own release must not be refused, and on arrival at the lease authority the membership transition force-clears the lease anyway (`Spec-003 §Required Behavior`, `reason: 'auto_released_authorization_lost'`), so no de-authorized hold outlives the signal. Domain authz code, HTTP row per the `membership.permission_denied` convention. | 403 |

### Workspace

| Code | Description | HTTP Status |
| --- | --- | --- |
| `workspace.not_found` | Workspace does not exist | 404 |
| `workspace.provisioning_failed` | Workspace provisioning failed due to an internal error | 500 |
| `workspace.mode_unsupported` | Requested execution mode is not supported for this workspace | 400 |
| `workspace.stale` | Workspace execution root is unavailable; new write runs are blocked until repair (`Spec-009 §Fallback Behavior`; thrown by the Plan-009 `assertWritable` write gate, CP-009-3) | 409 |
| `workspace.branch_mismatch` | `branch` mode bind-only verification failed: the main checkout's current branch does not match the requested branch context; the daemon never switches branches in the main checkout (`Spec-010 §Resolved Questions and V1 Scope Decisions`; Plan-010 D-010-9, Tier-6 audit) | 409 |
| `workspace.busy` | Workspace execution root is held by an active run; one holding run at a time in V1 (`Spec-010 §State And Data Implications`; Plan-010 D-010-16, Tier-6 audit) | 409 |
| `workspace.execution_root_unresolved` | A repo-bound run reached the setup gate with no resolved execution root for the workspace's selected mode and root preparation failed; the run parks in `starting` (`Spec-010 §Fallback Behavior`; Plan-010 D-010-16, Tier-6 audit) | 409 |
| `workspace.branch_name_required` | A writable-mode wire-initiated (pre-run) `repo.executionRootPrepare` omitted `branchName`: the Spec-010 slug rule's derivation inputs (queue-item summary / run id) exist only on the run-setup gate path, so wire prepares must carry the branch (Plan-010 D-010-19, Tier-6 audit) | 400 |

### Repo

Repo-mount attach/detach/resolution errors (Plan-009 D-009-3, Tier-6 audit). The `repo` namespace binds to the mount lifecycle; `workspace.*` binds to the bound-workspace lifecycle. `repo.outside_trust_envelope` and `repo.root_resolution_failed` messages MUST NOT echo the attempted path (error-sanitization discipline; the daemon substrate's `sanitizeFields` is the second layer).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `repo.not_found` | Repo mount does not exist | 404 |
| `repo.root_resolution_failed` | Canonical repository root could not be resolved for the supplied path; attach fails explicitly rather than guessing (`Spec-009 §Fallback Behavior`) | 422 |
| `repo.outside_trust_envelope` | Path or workspace binding resolves outside the session's declared local trust envelope (`Spec-009 §Required Behavior` + §Local Trust Envelope) | 403 |
| `repo.already_attached` | The resolved canonical root is already actively attached to this session on the same owning node (node-scoped active-mount uniqueness, Plan-009 D-009-7) | 409 |
| `repo.detach_conflict` | Detach refused while a dependent workspace is `busy`; no force-detach in V1 (`Spec-009 §Detach Semantics (V1 Definition)`) | 409 |

### Worktree

Worktree lifecycle errors (Plan-010 D-010-4, Tier-6 audit). The `worktree` namespace binds to worktree rows; mode-capability refusals stay on `workspace.mode_unsupported` (select-time, D-009-5) — there is deliberately no `worktree.unsupported` code, and prepare-time dynamic unavailability surfaces as `worktree.create_failed`. Failure messages MUST NOT echo attempted filesystem paths (error-sanitization discipline, same posture as §Repo).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `worktree.not_found` | Worktree does not exist | 404 |
| `worktree.create_failed` | Worktree creation failed (git error, filesystem error, or dynamic worktree unavailability at provisioning time); the owning workspace transitions to `stale` via `failReprovision` and the failure detail rides `workspace.stale` metadata | 500 |
| `worktree.branch_collision` | Caller-supplied branch name collides with a live checkout on the same mount; user intent is never silently adapted — daemon-derived default names ordinal-suffix instead (`Spec-010 §Resolved Questions and V1 Scope Decisions` collision policy) | 409 |
| `worktree.reuse_conflict` | Explicit reuse candidate is dirty without `acknowledgeDirtyCandidate`, incompatible with the requested branch strategy (never bindable), or no longer live (`Spec-010 §Fallback Behavior`) | 409 |
| `worktree.retire_conflict` | Retire refused while the worktree is the execution root held by an active run (busy owning workspace) | 409 |

### Ephemeral Clone

Ephemeral-clone lifecycle errors (Plan-010 D-010-4, Tier-6 audit). Same sanitization posture as §Worktree.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `clone.not_found` | Ephemeral clone does not exist | 404 |
| `clone.prepare_failed` | Ephemeral clone preparation failed; the owning workspace transitions to `stale` via `failReprovision` and the run stays blocked in setup (`Spec-010 §Fallback Behavior`) | 500 |

### Artifact

| Code | Description | HTTP Status |
| --- | --- | --- |
| `artifact.not_found` | Artifact does not exist | 404 |
| `artifact.too_large` | Artifact exceeds the maximum allowed size | 413 |
| `artifact.hash_mismatch` | Artifact content hash does not match the expected value | 409 |
| `artifact.relay_expired` | Relay blob TTL-expired or evicted; payload no longer fetchable from the relay (reserved — registers with Plan-014 Tasks 7–10 per [Spec-014 §Failure modes](../../specs/014-artifacts-files-and-attachments.md#failure-modes-normative-responses)) | 410 |
| `artifact.fetch_unauthorized` | Artifact fetch token refused: non-member, expired, or DPoP-unbound (reserved — registers with Plan-014 Tasks 7–10 per [Spec-014 §Failure modes](../../specs/014-artifacts-files-and-attachments.md#failure-modes-normative-responses)) | 403 |
| `artifact.no_access_key` | Authenticated session member has no `artifact_relay_recipients` row for the requested digest — a `(participant, node)` that joined after publish (membership-epoch scoping, Spec-014 Publish step 3); deliberately distinct from `artifact.fetch_unauthorized` so clients can surface the remedy (publisher re-publish while online) instead of treating it as an auth failure (reserved — registers with Plan-014 Tasks 7–10 per [Spec-014 §Cross-Node Artifact Relay (V1)](../../specs/014-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1)) | 404 |

Chunk-integrity mismatch on relay fetch reuses `artifact.hash_mismatch` (409). The three reserved rows are named by Spec-014's 2026-07-08 cross-node relay amendment (the no-access-key row by its 2026-07-09 extension) and become live registrations with Plan-014's relay legs after that plan's readiness-audit delta.

### Workflow

| Code | Description | HTTP Status |
| --- | --- | --- |
| `workflow.not_found` | Workflow definition does not exist | 404 |
| `workflow.invalid_phase` | Requested phase transition is invalid | 400 |
| `workflow.gate_closed` | Workflow gate has not been resolved and blocks progression | 409 |
| `workflow.start_denied` | Workflow run start refused — a matrix-denied principal or unresolvable chat-borne principal under the SA-39 named-action adjudication, or a `channelId` naming a channel the resolved starter is not a member of (SA-38 membership validation); one code, ordered arms with scoped disclosure — the role arm runs first and may carry a role-level message (the matrix is public surface; naming the role leaks nothing), and the SA-38 membership validation runs second, only for a matrix-admitted start, collapsing non-member and nonexistent channel into one byte-identical message (no membership or channel-existence oracle — the `runtimenode.permission_denied` collapse-where-it-leaks shape); Cedar-denial-as-domain-code per the `mcp.governance_denied` precedent (ADR-027) | 403 |

The `workflow.start_denied` row is the first landed entry of the extension the surface already owes (Plan-017 A-017-15 — three legacy codes against a fifteen-refusal-point surface, 2026-08-11 chat-start amendment); the remaining refusal points still await the extension.

### Driver

| Code | Description | HTTP Status |
| --- | --- | --- |
| `driver.unavailable` | Provider driver is currently unavailable | 503 |
| `driver.capability_unsupported` | Requested capability is not supported by the driver | 400 |
| `driver.timeout` | Provider driver operation timed out | 504 |
| `driver.cli_version_unparseable` | The provider CLI's reported version could not be parsed to a semantic version; capability attach/refresh fails closed and runs cannot start on this driver until the provider install is repaired (`Spec-005 §Required Behavior`, campaign B3 — the `workspace.stale` blocked-until-repair convention) | 409 |
| `driver.cli_version_below_floor` | The provider CLI's reported version parsed cleanly but is below the configured per-driver minimum floor; capability attach/refresh fails closed until the provider install is upgraded (`Spec-005 §Required Behavior`, campaign B3 — distinct from `version.floor_exceeded`, which is scoped to client/event-envelope contract floors, not provider CLI installs) | 409 |
| `driver.not_authenticated` | The zero-turn `probeAuth` did not report `authenticated` (`unauthenticated`, or `indeterminate` treated fail-closed); run admission is refused before any billed turn — remediation is re-authenticating the provider CLI on the runtime node (`Spec-005 §Required Behavior`, campaign B3). Mid-run credential expiry is the separate `reauth-required` `RecoveryCondition`, not this code | 409 |

### MCP Governance

| Code | Description | HTTP Status |
| --- | --- | --- |
| `mcp.server_not_found` | No server with the requested `(provider, scope, scopeRef, serverName)` binding exists in the unified inventory — identity is per-provider and per-scope, so a same-named server on the other provider or in another scope does not match (`Spec-028 §Unified Inventory`, campaign B18) | 404 |
| `mcp.config_invalid` | The submitted server configuration failed validation — malformed shape, unknown transport, or any refusal detectable **before the durable leg commits**; strictly pre-commit by contract: once the durable write has landed, per-leg live-application failures (including Claude `setMcpServers` per-server errors) report as `liveResults[]` entries on the successful response, never as this error, so a caller is never induced to retry a committed mutation (`Spec-028 §Configuration Mutation`, campaign B18) | 400 |
| `mcp.config_write_conflict` | Codex user-scope config write failed optimistic concurrency twice — the `expected_version` write and the single silent re-read-and-retry both hit `configVersionConflict`; the error carries both version tokens so the caller can re-inspect (`Spec-028 §Fallback Behavior`, campaign B18) | 409 |
| `mcp.idempotency_conflict` | A governance mutation's `clientIdempotencyKey` was reused with a differing request digest; the original mutation and its receipt are untouched and the conflicting request is refused — an identical retry instead replays the recorded response with no provider call, store write, or second event (`Spec-028 §Authorization`, campaign B18; the `intervention.idempotency_conflict` precedent) | 409 |
| `mcp.config_scope_unsupported` | The operation requires a mechanism the target binding's scope cannot support in V1 — a provider-config write at a non-`user` scope (Codex project-local `.codex/config.toml` and Claude `.mcp.json` / `local`-scope entries are read-only), a governance mutation on a binding V1 never materializes into runs (Claude project/local), or a native-write-only override facet (`enabled`/`approvalMode`) on a Codex `project` binding; guidance names the file to edit, in the message only, never in event payloads (`Spec-028 §Configuration Mutation`, campaign B18) | 400 |
| `mcp.operator_scope_required` | The caller is not the node-local operator — governance mutations arriving via control-plane relay are denied, not queued, under the V1 caller-owns-the-node model; the formalized remote-caller model is BL-141's scope (`Spec-028 §Authorization`, campaign B18) | 403 |
| `mcp.governance_denied` | Cedar denied the governance mutation under the `mcp` action family; authorization is evaluated before existence checks so the refusal is stable and does not leak inventory contents (`Spec-028 §Authorization`, campaign B18) | 403 |
| `mcp.trust_required` | A safety-weakening tool override — idempotency-class assignment off the `manual_reconcile_only` floor, an approval mode weaker than the provider default, or `enabled: true` (broadening the executable tool set) — was attempted on an untrusted server (`Spec-028 §Trust Governance`, campaign B18) | 403 |
| `mcp.oauth_flow_failed` | The provider failed to **launch** its OAuth flow — a provider-side error on the still-open `mcp.oauthLogin` call; strictly launch-phase: once the call has returned, an asynchronous completion failure is delivered as the `mcp.server_oauth_completed` event with `outcome: 'failure'` (observable on the `mcp.subscribe` stream), never as a late error on a completed call; the message never carries authorization URLs or credential material (`Spec-028 §OAuth Orchestration`, campaign B18) | 502 |
| `mcp.oauth_unsupported` | The provider cannot run the OAuth flow in-band in the current mode (Claude non-interactive); guidance names the out-of-band login command and the server's `needs-auth` status remains the visible state (`Spec-028 §OAuth Orchestration`, campaign B18) | 400 |

### Relay

| Code | Description | HTTP Status |
| --- | --- | --- |
| `relay.connection_failed` | Relay connection to the upstream service failed | 502 |
| `relay.group_full` | Relay group has reached its participant limit | 429 |
| `relay.authentication_failed` | Relay authentication failed | 401 |
| `relay.bundle_rejected` | Relay `SessionKeyBundle` admission rejected — the bundle's Ed25519 identity is not bound to a registered participant (Plan-008 I-008-7b). Distinct from the handshake-scoped `relay.authentication_failed`. | 403 |
| `relay.replay_rejected` | Relay frame rejected — the AEAD-bound sender sequence is ≤ the last accepted sequence for that sender (monotonic-seq replay; client-side detection per Plan-008 I-008-8) | 409 |
| `relay.bundle_signature_invalid` | Peer `SessionKeyBundle` rejected on client-side defense-in-depth re-verification — the Ed25519 signature over `session_id ‖ ephemeral_x25519_public` failed (Plan-008 I-008-7a) | 403 |

### Transport

Wire-level codes describing peer mis-use of the framing/handshake layer. Distinct from §Resource (which describes domain-level quota saturation): a transport failure is a peer behaving incorrectly toward the protocol substrate, not a session/run/invite quota refusing additional creates.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `transport.unavailable` | Requested transport (e.g. loopback fallback) is not enabled for this daemon process per its conservative-default gate (Plan-007 F-007p-2-09) | 503 |
| `transport.message_too_large` | Inbound frame's declared body length exceeded the 1MB cap, or daemon-side outbound build exceeded it (Plan-007 F-007p-2-05/F-007p-2-11). 413 semantic. | 413 |
| `transport.invalid_protocol_version` | Per-request envelope-level `protocolVersion` field violates `Spec-007 §Wire Format` (BL-102 ratification): the field is missing, the wrong JS type, or fails the ISO 8601 `YYYY-MM-DD` shape. Substrate-side gate; fires BEFORE handler dispatch (I-007-7). Distinct from `version.floor_exceeded` / `version.ceiling_exceeded` (registry-side handshake-incompatibility) and from `protocol.version_mismatch` (registry-side mutating-op gate after handshake declared incompatible). 400 semantic. | 400 |

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

Daemon-local data-subject-request codes (Plan-022). The V1.1 erasure / export / purge handlers are daemon-bound — they read daemon-local `participant_keys` + the `sodium_mlock`-held master key, which the Cloudflare-Workers control plane cannot reach — so these codes ride the **daemon JSON-RPC wire only**: the HTTP status below is notional, and the numeric discriminator is pinned in [§JSON-RPC Wire Mapping → §Plan-022 Tier 5 Domain Identifiers](#plan-022-tier-5-domain-identifiers).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `gdpr.endpoint_not_v1` | A `gdpr.*` data-subject endpoint (session purge / participant export / participant delete) was invoked in V1; the registered daemon stub returns the not-implemented envelope unconditionally, reserving the namespace for the V1.1 handler (Plan-022 D-022-3 / I-022-17) | 501 |

### Admin

Operator admin-surface codes (Plan-021 admin-bans API, [D-021-1](../../plans/021-rate-limiting-policy.md#ratified-design-decisions-tier-6-audit)). The surface authenticates via the deployment's operator admin token; an absent or malformed credential maps to the existing `auth.token_invalid` row (401) — no admin-namespace auth code exists.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `admin.forbidden` | Operator admin token present but mismatched on the admin-bans surface (constant-time compare failed) | 403 |
| `admin.ban_not_found` | `DELETE /admin/bans/:id` targeted a missing or already-revoked ban (revoke is not idempotent) | 404 |
| `admin.ban_already_exists` | Losing side of the one-active-ban race: an **active** (non-revoked, non-expired) ban already exists for `(identity, identity_type)` (Postgres `23505` on the partial unique index, I-021-6). An expired-but-unrevoked standing ban does not refuse — the issue path supersedes it (atomic revoke-then-insert, Plan-021 D-021-12) | 409 |

### Version

Cross-version compatibility errors per [ADR-018](../../decisions/018-cross-version-compatibility.md) §Decision #4. These errors fire when a client, daemon, or event envelope declares a version outside the accepted range for the session or the platform. The wire/persisted envelope version is a semver `MAJOR.MINOR` string per `ADR-018 §Decision` #1 — numeric form is rejected at validation. Typed error names (`VERSION_FLOOR_EXCEEDED`, `VERSION_CEILING_EXCEEDED`) from ADR-018 map to the dotted registry codes below.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `version.floor_exceeded` | Client attach or event envelope version is below the session's `min_client_version` floor per [ADR-018](../../decisions/018-cross-version-compatibility.md) §Decision #3 / §Decision #4 (typed: `VERSION_FLOOR_EXCEEDED`; the bound-checked version is the branded `EventEnvelopeVersion` — validated by `packages/contracts/src/event.ts#EventEnvelopeVersionSchema` per `Spec-006 §EventEnvelope Version Semantics`) | 409 |
| `version.ceiling_exceeded` | Event envelope version exceeds the maximum supported by the reading party per `ADR-018 §Decision` #10 (typed: `VERSION_CEILING_EXCEEDED`; same branded comparand — `packages/contracts/src/event.ts#EventEnvelopeVersionSchema`, `Spec-006 §EventEnvelope Version Semantics`) | 409 |

`version.floor_exceeded` is **surface-polymorphic** — the same wire code carries a different shape on each of its three emitting surfaces:

1. **JSON-RPC daemon handshake** (version negotiation, [Spec-007](../../specs/007-local-ipc-and-daemon-control.md)): it is a `DaemonHelloAck.reason` discriminator **string** — _not_ a `details` payload (see [§Negotiation Refusals](#negotiation-refusals), where the row is `n/a (DaemonHelloAck.reason field)`). The handshake's structured detail, when present, rides the separate JSON-RPC `data.fields` channel of the [two-layer envelope](#two-layer-envelope-shape).
2. **Control-plane peer-floor validation** (Plan-002+ invite-acceptance validating a peer's client floor — the canonical emit site of `VersionFloorExceededError` per `packages/contracts/src/error.ts`): it carries the strict two-sided `VersionBoundExceededDetails` (`attemptedVersion` + `acceptedRange.{min,max}`) in an HTTP `ErrorResponse`, describing the receiver's accepted version range.
3. **Control-plane runtime-node write-refusal** ([Spec-003 §Required Behavior](../../specs/003-runtime-node-attach.md#required-behavior) / [ADR-018](../../decisions/018-cross-version-compatibility.md) §Decision #4 — a below-floor node admitted read-only at attach is refused on its later version-sensitive domain write — a capability declaration, or from Plan-006 T4.10 a signing-key registration): it is **code+message-only**. The session floor is one-sided (`sessions.min_client_version`, with no `max` anywhere), so the two-sided `VersionBoundExceededDetails` schema of surface (2) cannot be populated; the daemon already learned its read-only verdict at attach; and the `message` carries leak-free upgrade context (the node id, the daemon's declared client version, and the session floor).

The canonical `ErrorResponse` envelope makes `details` optional, so surfaces (2) and (3) are both valid `ErrorResponse` forms.

### Event

Event-replay cursor errors (Plan-006). Like the §Run / §Queue namespaces these ride the daemon JSON-RPC wire with the dotted code as the canonical `data.type` identifier; the HTTP status is the control-plane-notional mapping.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `event.cursor_unresolvable` | An `EventCursor` submitted to `readAfterCursor` / `readWindow` cannot be decoded to a log position — `decodeEventCursor` rejects a non-integer or a value `< -1` (a legacy SDK-synthesized UUID, a corrupted cursor) under the Plan-006 T4.3 predecessor-position cursor model (typed: `CURSOR_UNRESOLVABLE`) | 400 |

### Daemon

Daemon-local write-path refusals (Plan-006). Like §Event these ride the daemon JSON-RPC wire with the dotted code as the canonical `data.type` identifier; the HTTP status is the control-plane-notional mapping. Registered by the Plan-006 T3.1-seam targeted readiness-audit delta (F-006-HALT-03, PR #282, 2026-08-02).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `daemon.ingest_halted` | `EventLogService.append` refuses a session whose ingest is administratively halted — the T4.2 key-reuse observer published `halt(sessionId)` through T3.1's `IngestHaltRegistry` and the collision persists in the key stores; carries the refused `sessionId` (`data.fields`: `sessionId`, typed `DaemonIngestHaltedDetailsSchema`); re-admission only via `clear(sessionId)` when the collision leaves the observable set (Plan-006 T3.1 / I-006-4-03; typed: `DAEMON_INGEST_HALTED_CODE`; a state-dependent refusal of an otherwise-valid write, hence 409 — the `run.invalid_transition` / `channel.inactive` / `agent.not_ready` state-refusal shape) | 409 |
| `daemon.pii_split_bypass` | `EventLogService.append` refuses a write whose `payload` carries a PII-tagged field with no `pii_ciphertext_digest` — the write bypassed the T2.4 `pii-indirection.ts` sole-write-path split; a hard write-path rejection, structurally invalid regardless of session state, unlike the state-dependent `daemon.ingest_halted` (Plan-006 T3.1; typed: `DAEMON_PII_SPLIT_BYPASS_CODE`; `data.fields`: `fieldPath` — the offending field's payload key path, never its value — typed `DaemonPiiSplitBypassDetailsSchema`; the write-path-refusal sibling the ingest-halt clause cites as precedent — the typed wire error, distinct from the `daemon.pii_split_ambiguous` taxonomy event — that event signals a SUCCESSFUL containment fallback, an ambiguous record routed wholesale into `pii_payload`, never a failed write; the Spec-006 census row draws exactly that distinction rather than characterizing this rejection) | 400 |
| `daemon.event_canonical_bytes_exceeded` | `EventLogService.append` refuses a write whose `canonical_bytes(row)` exceeds `EVENT_CANONICAL_BYTES_MAX` = 32 KiB ([Spec-006 §Canonical Serialization Rules](../../specs/006-session-event-taxonomy-and-audit-log.md#canonical-serialization-rules), 2026-08-11 amendment) — the serviceability bound that keeps every row re-publishable inside one 64 KB relay frame on the [Spec-008 §Peer History Backfill On Join (V1)](../../specs/008-control-plane-relay-and-session-join.md#peer-history-backfill-on-join-v1) seam (base64 4/3 expansion + members + AEAD + framing ≈45 KiB worst case); a hard write-path rejection of the `daemon.pii_split_bypass` class, structurally invalid regardless of session state — refused before any row is written, never truncated (registered 2026-08-11, Codex PR #323 round 2; the code constant and enforcement landed 2026-08-12 with the Plan-006 follow-up code PR the Spec-006 bullet names, PR #324) | 400 |

---

## Rate Limiting

Standard 429 response shape (from API Payload Contracts):

```ts
interface RateLimitResponse {
  code: "rate_limited";
  retryAfter?: number; // seconds until retry is allowed — sliding-window/escalation refusals; omitted on concurrency-cap refusals (capacity frees on release; no reset clock — Spec-021 §Overflow Response)
  limit: number; // total allowed requests in the window (the cap itself on concurrency-cap refusals)
  remaining: number; // requests remaining in the current window
  resetAt?: string; // ISO 8601 timestamp when the limit resets — same enforcement-class rule as retryAfter
}
```

All rate-limited endpoints return the `RateLimitResponse` envelope with HTTP status 429. The `resetAt` field provides the absolute timestamp (ISO 8601) when the rate limit window resets, complementing the relative `retryAfter` seconds value. The timing pair is enforcement-class-conditional (`Spec-021 §Overflow Response`): sliding-window and escalation refusals carry both; concurrency-cap refusals omit both fields and the `Retry-After`/`X-RateLimit-Reset` headers — cap capacity frees when an existing holder releases, not at a known timestamp.

Rate limit error codes that trigger this response:

- `session.limit_exceeded`
- `run.limit_exceeded`
- `invite.limit_exceeded`
- `relay.group_full`
- `resource.limit_exceeded`

Enforcement-layer codes outside the 429 envelope (Plan-021, Tier-6 audit). These use the standard `ErrorResponse` envelope, not `RateLimitResponse`:

| Code | Description | HTTP Status |
| --- | --- | --- |
| `ratelimit.banned` | Request refused because an active admin ban matches the caller identity; terminal — no counter capacity consumed (admission order ban → block → counter, Plan-021 I-021-1) | 403 |
| `ratelimit.backend_unavailable` | Rate-limit backend unreachable past the fail-open grace window (`AIS_RATELIMIT_FAILOPEN_SECONDS`); enforcement fails closed | 503 |
