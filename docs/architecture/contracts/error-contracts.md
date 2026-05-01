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
| `transport.message_too_large` | `-32600` | Inbound frame exceeded the 1MB body cap (per F-007p-2-05; the spec-required InvalidRequest classification per Plan-007:268 mapping). Distinct from Spec-001's `resource.limit_exceeded` (HTTP-429 domain quota saturation): a 413-semantic peer mis-framing of the wire layer. |
| `transport.invalid_protocol_version` | `-32600` | Per-request envelope-level `protocolVersion` field violates Spec-007:54 (BL-102 ratified): missing, wrong type, or fails the ISO 8601 `YYYY-MM-DD` shape. The substrate gate at `local-ipc-gateway.ts#dispatchFrame` enforces per I-007-7 BEFORE handler dispatch; the handshake (`daemon.hello`) is exempt because the negotiation parameter rides in `params.protocolVersion`. Distinct from `protocol.version_mismatch` (NegotiationError, registry-side gate for incompatible negotiated versions on subsequent mutating ops): the wire-layer envelope shape gate fires once-per-frame, the registry-side gate fires once-per-incompatible-mutating-op. |

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
| `protocol.version_mismatch` | `-32600` | NegotiationError | Mutating dispatch attempted in `done-incompatible` state (Spec-007:67-68) |

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

| Code                     | Description                                            | HTTP Status |
| ------------------------ | ------------------------------------------------------ | ----------- |
| `session.not_found`      | Session does not exist or is not accessible            | 404         |
| `session.already_closed` | Session has already been closed and cannot be modified | 409         |
| `session.limit_exceeded` | Session creation rate limit exceeded                   | 429         |

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

### Approval

| Code | Description | HTTP Status |
| --- | --- | --- |
| `approval.not_found` | Approval request does not exist | 404 |
| `approval.already_resolved` | Approval request has already been resolved | 409 |
| `approval.expired` | Approval request has expired and can no longer be resolved | 410 |

### Invite

| Code                      | Description                                      | HTTP Status |
| ------------------------- | ------------------------------------------------ | ----------- |
| `invite.not_found`        | Invite does not exist                            | 404         |
| `invite.already_accepted` | Invite has already been accepted                 | 409         |
| `invite.expired`          | Invite has expired and can no longer be accepted | 410         |
| `invite.revoked`          | Invite has been revoked by the issuer            | 410         |
| `invite.limit_exceeded`   | Invite creation rate limit exceeded              | 429         |

### Workspace

| Code | Description | HTTP Status |
| --- | --- | --- |
| `workspace.not_found` | Workspace does not exist | 404 |
| `workspace.provisioning_failed` | Workspace provisioning failed due to an internal error | 500 |
| `workspace.mode_unsupported` | Requested execution mode is not supported for this workspace | 400 |

### Artifact

| Code                     | Description                                             | HTTP Status |
| ------------------------ | ------------------------------------------------------- | ----------- |
| `artifact.not_found`     | Artifact does not exist                                 | 404         |
| `artifact.too_large`     | Artifact exceeds the maximum allowed size               | 413         |
| `artifact.hash_mismatch` | Artifact content hash does not match the expected value | 409         |

### Workflow

| Code | Description | HTTP Status |
| --- | --- | --- |
| `workflow.not_found` | Workflow definition does not exist | 404 |
| `workflow.invalid_phase` | Requested phase transition is invalid | 400 |
| `workflow.gate_closed` | Workflow gate has not been resolved and blocks progression | 409 |

### Driver

| Code | Description | HTTP Status |
| --- | --- | --- |
| `driver.unavailable` | Provider driver is currently unavailable | 503 |
| `driver.capability_unsupported` | Requested capability is not supported by the driver | 400 |
| `driver.timeout` | Provider driver operation timed out | 504 |

### Relay

| Code                          | Description                                     | HTTP Status |
| ----------------------------- | ----------------------------------------------- | ----------- |
| `relay.connection_failed`     | Relay connection to the upstream service failed | 502         |
| `relay.group_full`            | Relay group has reached its participant limit   | 429         |
| `relay.authentication_failed` | Relay authentication failed                     | 401         |

### Transport

Wire-level codes describing peer mis-use of the framing/handshake layer. Distinct from §Resource (which describes domain-level quota saturation): a transport failure is a peer behaving incorrectly toward the protocol substrate, not a session/run/invite quota refusing additional creates.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `transport.unavailable` | Requested transport (e.g. loopback fallback) is not enabled for this daemon process per its conservative-default gate (Plan-007 F-007p-2-09) | 503 |
| `transport.message_too_large` | Inbound frame's declared body length exceeded the 1MB cap, or daemon-side outbound build exceeded it (Plan-007 F-007p-2-05/F-007p-2-11). 413 semantic. | 413 |
| `transport.invalid_protocol_version` | Per-request envelope-level `protocolVersion` field violates Spec-007:54 (BL-102 ratification): the field is missing, the wrong JS type, or fails the ISO 8601 `YYYY-MM-DD` shape. Substrate-side gate; fires BEFORE handler dispatch (I-007-7). Distinct from `version.floor_exceeded` / `version.ceiling_exceeded` (registry-side handshake-incompatibility) and from `protocol.version_mismatch` (registry-side mutating-op gate after handshake declared incompatible). 400 semantic. | 400 |

### Resource

| Code                      | Description                     | HTTP Status |
| ------------------------- | ------------------------------- | ----------- |
| `resource.limit_exceeded` | General resource limit exceeded | 429         |

### System

| Code                    | Description                      | HTTP Status |
| ----------------------- | -------------------------------- | ----------- |
| `system.internal_error` | Unexpected internal error        | 500         |
| `system.maintenance`    | System is undergoing maintenance | 503         |

### Version

Cross-version compatibility errors per [ADR-018](../../decisions/018-cross-version-compatibility.md) §Decision #4. These errors fire when a client, daemon, or event envelope declares a version outside the accepted range for the session or the platform. The wire/persisted envelope version is a semver `MAJOR.MINOR` string per ADR-018 §Decision #1 — numeric form is rejected at validation. Typed error names (`VERSION_FLOOR_EXCEEDED`, `VERSION_CEILING_EXCEEDED`) from ADR-018 map to the dotted registry codes below.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `version.floor_exceeded` | Client attach or event envelope version is below the session's `min_client_version` floor per [ADR-018](../../decisions/018-cross-version-compatibility.md) §Decision #3 / §Decision #4 (typed: `VERSION_FLOOR_EXCEEDED`) | 409 |
| `version.ceiling_exceeded` | Event envelope version exceeds the maximum supported by the reading party per ADR-018 §Decision #4 (typed: `VERSION_CEILING_EXCEEDED`) | 409 |

---

## Rate Limiting

Standard 429 response shape (from API Payload Contracts):

```ts
interface RateLimitResponse {
  code: "rate_limited";
  retryAfter: number; // seconds until retry is allowed
  limit: number; // total allowed requests in the window
  remaining: number; // requests remaining in the current window
  resetAt: string; // ISO 8601 timestamp when the limit resets
}
```

All rate-limited endpoints return the `RateLimitResponse` envelope with HTTP status 429. The `resetAt` field provides the absolute timestamp (ISO 8601) when the rate limit window resets, complementing the relative `retryAfter` seconds value.

Rate limit error codes that trigger this response:

- `session.limit_exceeded`
- `run.limit_exceeded`
- `invite.limit_exceeded`
- `relay.group_full`
- `resource.limit_exceeded`
