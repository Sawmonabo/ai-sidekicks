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

Local IPC traffic (Plan-006 daemon ↔ in-tree clients) frames errors per [JSON-RPC 2.0 §5.1](https://www.jsonrpc.org/specification#error_object), which structurally requires `code` to be a Number. The dotted-namespace identifier (the canonical project code in §Error Codes below) rides in `data.type` per the [RFC 7807 Problem Details](https://datatracker.ietf.org/doc/html/rfc7807) precedent for structured error responses and the [LSP 3.17 ResponseError](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#responseError) field convention.

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

### Plan-006 Domain Identifiers

| `data.type` | JSON-RPC `code` | Trigger |
| --- | --- | --- |
| `unknown_setting` | `-32602` | Bootstrap rejected an unrecognized SecureDefaults config key (T-006p-1-4) |
| `transport.unavailable` | `-32603` | The client cannot reach the daemon's OS-local socket or named pipe; no fallback transport exists |
| `transport.message_too_large` | `-32600` | Inbound frame exceeded the 4 MB body cap (the InvalidRequest classification of [Plan-006 §Phase 2: Wire Substrate](../../plans/006-local-ipc-and-daemon-control.md#phase-2-wire-substrate), T-006p-2-2). It is a 413-semantic peer mis-framing of the wire layer, never a domain-level refusal. |
| `transport.invalid_protocol_version` | `-32600` | Per-request envelope-level `protocolVersion` field violates [Spec-006 §Wire Format](../../specs/006-local-ipc-and-daemon-control.md#wire-format): missing, wrong type, or fails the ISO 8601 `YYYY-MM-DD` shape. The substrate `dispatchFrame` gate in `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts#LocalIpcGateway` enforces per I-006-7 BEFORE handler dispatch; the handshake (`daemon.hello`) is exempt because the negotiation parameter rides in `params.protocolVersion`. Distinct from `protocol.version_mismatch` (NegotiationError, registry-side gate for incompatible negotiated versions on subsequent mutating ops): the wire-layer envelope shape gate fires once-per-frame, the registry-side gate fires once-per-incompatible-mutating-op. |

`data.fields` shape per code:

- `unknown_setting`: `{ setting: string, value: unknown }`
- `transport.unavailable`: `{ reason: string }`
- `transport.message_too_large`: `{ limit: number, observed: number }`
- `transport.invalid_protocol_version`: `{ reason: "missing" | "wrong_type" | "invalid_format", observedType?: string }` (`observedType` is the JS-typeof tag of the offending value, present only when `reason === "wrong_type"`; the offending VALUE itself is NOT echoed back so client-supplied content does not leak through observability)

### Negotiation Refusals

`NegotiationError` throws (the gate-refusal codes in `packages/runtime-daemon/src/ipc/protocol-negotiation.ts`) and `DaemonHelloAck.reason` strings (the handshake-incompatible reasons in `packages/contracts/src/jsonrpc-negotiation.ts`) all map through the same envelope. The reason strings are canonicalized to dotted-namespace form:

| `data.type` | JSON-RPC `code` | Surface | Trigger |
| --- | --- | --- | --- |
| `version.floor_exceeded` | n/a (DaemonHelloAck.reason field) | DaemonHelloAck | Client below daemon's lex-min supported version |
| `version.ceiling_exceeded` | n/a (DaemonHelloAck.reason field) | DaemonHelloAck | Client above daemon's lex-max supported version |
| `protocol.handshake_already_completed` | n/a (DaemonHelloAck.reason field) | DaemonHelloAck | Second `daemon.hello` on a connection with latched outcome |
| `protocol.handshake_required` | `-32600` | NegotiationError | Mutating dispatch attempted in `pre` state (I-006-1) |
| `protocol.version_mismatch` | `-32600` | NegotiationError | Mutating dispatch attempted in `done-incompatible` state ([Spec-006 §Fallback Behavior](../../specs/006-local-ipc-and-daemon-control.md#fallback-behavior)) |

### Test-Side Discrimination

Test code asserting on JSON-RPC error envelopes MUST discriminate on `data.type` for project-level expectations and on `code` for JSON-RPC-level expectations, and asserts the whole envelope:

```ts
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

Every namespace below follows the same rules:

- **One code per refusal.** A code names one refusal a caller can act on, and that refusal has exactly one code; no code is a second name for another.
- **Listed reasons.** Where one refusal has several causes, the code carries `data.fields.reason` from a list registered with the code, never free text.
- **The owner's namespace.** A code sits under the root of the domain whose operation refuses (`repo`, `worktree`, `gitflow`), in the registry's `<root>.<noun>_<condition>` form in `snake_case`, the noun left out where the root is itself what is refused (`session.not_found`).
- **No structure prefixes.** A root names that domain, never the layer, process or pane a refusal passes through.
- **Current words only.** A code uses the product's current words and names only a concept the product has.
- **Registered before it is raised.** The unit that builds a capability registers that capability's codes and their reason lists in its contract in `packages/contracts` before the capability is implemented, never while implementing it, and each section below lists what its contract registers. No refusal ships without a registered code.

### Session

| Code                     | Description                                            | HTTP Status |
| ------------------------ | ------------------------------------------------------ | ----------- |
| `session.not_found`      | Session does not exist or is not accessible            | 404         |
| `session.already_closed` | Session has already been closed and cannot be modified | 409         |

### Auth

| Code | Description | HTTP Status |
| --- | --- | --- |
| `auth.token_expired` | Authentication token has expired | 401 |
| `auth.token_invalid` | Authentication token is malformed or invalid | 401 |
| `auth.insufficient_scope` | Token does not have the required scope for this operation | 403 |
| `auth.dpop_mismatch` | DPoP proof does not match the bound token | 401 |

### Run

| Code | Description | HTTP Status |
| --- | --- | --- |
| `run.invalid_transition` | Requested state transition is not allowed from the current run state | 409 |
| `run.not_found` | Run does not exist or is not accessible | 404 |
| `run.recovery_failed` | Run recovery failed due to an internal error | 500 |
| `run.child_control_refused` | A control on one named child of a run — `run.childSteer`, `run.childInterrupt` or `run.childPauseSet`, or a queue verb carrying `childHandle` — refused. `data.fields.reason` is one of `child_unknown` (the handle names no child of this run), `child_ended` (the child has already ended) or `provider_refused` (the provider declined the control). A child the daemon bridges is its own run and is controlled through that run's own verbs; a lost hold is a result on the reply, never this refusal | 409 |

### Queue

Daemon-local run-queue control codes (Plan-003). Run-control authority is daemon-only ([ADR-003](../../decisions/003-daemon-backed-queue-and-interventions.md)), so — like the §Run namespace — these ride the daemon JSON-RPC wire with the dotted code as the canonical `data.type` identifier and the HTTP status as the control-plane-notional mapping; no separate §JSON-RPC numeric pin (the §Run domain-code convention).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `queue.persistence_unavailable` | New queued run-control work was rejected fail-closed because the daemon's queue-persistence layer is unavailable (Plan-003 I-003-1 / ADR-003 — block new queued work when persistence is unavailable) | 503 |

### Intervention

Intervention request-admission codes ([Spec-004 §Required Behavior](../../specs/004-provider-driver-contract-and-capabilities.md#required-behavior)). Intervention **outcomes** deliberately resolve via the six-state lifecycle (`rejected` / `expired` / `degraded` are states, not error codes — [queue-and-intervention-model.md §Driver Result To Lifecycle Mapping](../../domain/queue-and-intervention-model.md#driver-result-to-lifecycle-mapping)); this namespace covers only request-level refusals that never produce an intervention row. The token deliberately collides with no `intervention.*` durable event name (`requested`/`accepted`/`applied`/`rejected`/`degraded`/`expired` — the never-collide rule, D-010-4 convention).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `intervention.idempotency_conflict` | A `clientIdempotencyKey` was reused with a differing payload; the original intervention is untouched and the conflicting request is refused (an identical retry is not an error — it replays the recorded outcome). Semantic payload conflict per the converging idempotency-key practice (`data.fields`: `targetRunId`, `interventionId` of the original) | 422 |

### Orchestration

Orchestration admission-refusal codes (Plan-014 D-014-16). Every code is a zero-residue create-time refusal — no run row, no queue item, no partial state survives the rejection (I-014-8); the daemon additionally records the refusal durably via the `orchestration.rejected` event ([Spec-014 §Example Flows](../../specs/014-multi-agent-orchestration.md#example-flows) "records the refusal visibly"). The event name `orchestration.rejected` and these error codes share a root but no token collides with an event name. The parent-run-missing case reuses §Run `run.not_found` (no new semantic — D-014-16).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `orchestration.budget_exhausted` | The session's spend limit is reached — no turn starts until the person raises the limit; `observedValue` carries the session's spend from the service's own spend count ([Spec-014 §Budget Policies](../../specs/014-multi-agent-orchestration.md#budget-policies); `data.fields`: `budgetType`, `limitValue`, `observedValue`) | 429 |

### Agent

Agent-surface codes (Plan-014 D-014-16; the provider axis, D-014-26).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `agent.not_found` | Agent does not exist in the session (`data.fields`: `agentId`) | 404 |
| `agent.provider_axis_invalid` | A provider-axis member on `agent.configUpdate` names something the machine cannot honor: an unregistered driver, a model absent from the target driver's `listModels`, an effort absent from that model's `effortLevels`, or an output-speed value absent from that driver's `outputSpeedLevels` ([Spec-014 §Same-Agent Provider Switch](../../specs/014-multi-agent-orchestration.md#same-agent-provider-switch)). Refused **before** any turn is started on the target, so a rejected switch spends nothing. `data.fields`: `agentId`, `axis` (`driverName` \| `modelId` \| `effort` \| `outputSpeed`), `value`. The axis names are the member names of the request, so this discriminator **is** the `AgentProviderAxis` union in [api-payload-contracts.md §Plan-014](./api-payload-contracts.md) rather than a second spelling of it: one axis vocabulary, every member of which this refusal can name. The `outputSpeed` arm is **vocabulary validation and nothing else**: it covers a target driver whose declared `outputSpeedLevels` is absent or empty — which makes the axis unsettable — and a value outside a vocabulary the driver did declare. It deliberately does **not** cover a driver declaring `output_speed: false`, which is the axis not existing on that provider rather than a bad value in it, and which refuses as the already-registered `driver.capability_unsupported` on the ordinary capability gate ([Spec-004 §The output-speed axis](../../specs/004-provider-driver-contract-and-capabilities.md#the-output-speed-axis), [Spec-014 §The mutation surface](../../specs/014-multi-agent-orchestration.md#the-mutation-surface), and Plan-014 T2.16's validation leg all order it capability-check-then-value-check). Two canonical refusals for one request would leave implementers and clients to pick, so the gate that runs first owns the refusal. Both arms still refuse fail-closed before any unvalidated setting reaches a provider spawn. It does not cover an accepted switch that later could not be applied, which reaches the caller as the `agent.provider_binding_change_failed` event's own `output_speed_unavailable` reason instead; the two vocabularies stay separate for the reason [Spec-005 §Agent Lifecycle](../../specs/005-session-event-taxonomy-and-audit-log.md#agent-lifecycle-session_lifecycle) already states. A switch that fails after it was accepted leaves the agent on its previous binding and lands one system message, with `Sign in again` only where the reason is `account_unavailable` and the account's state is `reauth_required`. **Which account pays is not an axis of this request at all**, so no arm here names one: the account a session runs on moves on the provider surface through `providerAccount.setCurrent` ([Spec-026 §Moving a session to another account](../../specs/026-provider-accounts-and-credential-homes.md#moving-a-session-to-another-account)), and an unregistered or unknown account refuses in the provider-account namespace (`provideraccount.unknown` / `provideraccount.not_registered`), which is both the owner of that fact and the refusal [Spec-026 §Fallback Behavior](../../specs/026-provider-accounts-and-credential-homes.md#fallback-behavior) names for a provider with no registered account. A second answer to one question here would route the person nowhere | 400 |

### Approval

| Code | Description | HTTP Status |
| --- | --- | --- |
| `approval.not_found` | Approval request does not exist | 404 |
| `approval.already_resolved` | Approval request has already been resolved | 409 |
| `approval.request_canceled` | Approval request was canceled (its run ended — an interrupt among the ways it can — its session closed, the provider process ended, or its originating provider ask was retracted before resolution — Plan-010 T2.8's live-leg cancel ingress) and can no longer be resolved; also the late-CREATE refusal — a create arriving for an already-ended run or already-closed session (Plan-010 T2.12). The **late-CREATE refusal shape** carries a typed `reason` extension member — `'run_ended' \| 'session_closed'` — per RFC 9457 §3.2 extension-member practice, derived from live terminal state at refusal time (a retraction can never cause a late CREATE — the request already exists when a retraction settles it); the resolve-path 409 for an already-canceled request carries no `reason` (the cancellation cause is not persisted on `approval.canceled` — audit reconstructs it from the adjacent run/session terminal rows on the timeline) | 409 |
| `approval.persistence_unavailable` | A permission check or approval mutation was rejected fail-closed because the daemon's approval-persistence layer is unavailable ([Spec-010 §Fallback Behavior](../../specs/010-approvals-permissions-and-trust-boundaries.md#fallback-behavior) — the sensitive action must not proceed) | 503 |
| `approval.rule_not_found` | Approval rule does not exist where the provider keeps it | 404 |
| `approval.rule_already_revoked` | Approval rule has already been revoked | 409 |
| `approval.denial_not_found` | `approval.denialOverride` names a `denialId` the daemon holds no block for | 404 |
| `approval.denial_not_overridable` | `approval.denialOverride` names a block the provider's own reviewer marked not overridable (`overridable: false`), so no person can overrule it | 409 |

**No code names an expired request, because a request never expires.** An approval waits until it is answered; moving the session's permission level to one that never asks answers an open request rather than canceling it — the blocked call runs — and the only cancellations are an interrupt or any other end of its run and the provider process ending, so `approval.request_canceled` is the only cancellation code. That token deliberately differs from the Spec-005 durable event name `approval.canceled` so an error code never collides with an event name (the same never-collide rule the `runtimenode` namespace documents below). No `approval.permission_denied` code exists: nothing checks which of the person's devices answers, `PermissionCheck` denial is a normal `allowed: false` response rather than an error, and a session belongs to one person.

### User

WebAuthn-ceremony refusals (Plan-016 Phase 6). Both codes are served on **control-plane routes** rather than a daemon `user.*` method — the web client and the phone apps call them over their authenticated control-plane channel, the device-code page's approval route answers them too, and the desktop app carries no WebAuthn — so they carry no §JSON-RPC pin.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `user.webauthn_challenge_invalid` | The WebAuthn ceremony challenge presented at verification is unknown, already consumed, or expired — challenges are single-use and short-lived, consumed atomically by the fence's `DELETE ... RETURNING` (Plan-016 T6.4 / I-016-15). Domain validation code. | 400 |
| `user.webauthn_verification_failed` | A WebAuthn registration or assertion response failed verification. Deliberately **one** code for every arm — bad signature, wrong origin, wrong `rpId`, unknown credential, regressed signature counter, and a user-verification bit disagreeing with the mode stored at registration — so the reply is no oracle for which check failed (Plan-016 T6.2 / T6.3 / I-016-16 / I-016-17). Domain validation code. | 400 |

### Runtime Node

This code is registry-only (code + message; no structured `details`): no acceptance criterion needs structured detail, and a detail naming the machine would say whether it exists. The domain token `runtimenode` matches the method namespace ([API Payload Contracts §Machine Registration Method Registry](./api-payload-contracts.md#machine-registration-method-registry)).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `runtimenode.permission_denied` | Caller is not authorized for the machine the request names: the caller's verified principal does not own the machine the request's `nodeId` names (`runtime_nodes.user_id`). Another user's machine and an unknown machine collapse into this one refusal, so it never says whether the machine exists (this namespace's header). Domain authz code; deliberately never tRPC `NOT_FOUND`, which on this namespace means only that the control plane has no such procedure. | 403 |

### PTY

Terminal write-lease refusals ([Spec-002 §Required Behavior](../../specs/002-runtime-node-attach.md#required-behavior)). The lease is **one per shell**: a session opens as many shells as the node can hold, exactly one writer holds a given shell at a time, and no holder means writes to that shell are refused (fail-closed). Every refusal below is about one shell, named by the terminal identifier the request carried, and a lease held on one shell never authorizes a write to another.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `pty.control_not_held` | A write to a shell attempted without holding that shell's write lease — take it first (null-holder-refuses-writes) | 409 |
| `pty.control_held_by_other` | `session.takeControl` refused for the named shell. **Two refusals share this code; the second has the stronger precondition.** A plain take while another of the account's devices holds that shell: refused, and the recourse is the take's forced form, which moves the lease to the taker without a release. Any take while the hold belongs to a run that is writing: refused, and normatively so, because a run's writes are stopped by intervening on the run and never by a lease contest — the recourse is pause or interrupt, and the run-lifecycle release then frees that shell on the run's first transition out of running. `data.fields.holder` names the holder as `pty.control_changed` does — `{ holderDeviceId, holderRunId? }`, with `holderRunId` set while an agent's run holds the shell and the agent read from that run — on the JSON-RPC surface, mirrored as `details.holder` on the HTTP `ErrorResponse` envelope (same value on both surfaces, via the canonical envelope's structured-context field) | 409 |

Opening a shell on a session that is a chat is refused: a chat has no folder, so it has no shells. The screen never offers the control on a chat, so only a caller fault reaches this refusal. Its code is the one `packages/contracts/src/pty.ts` registers with `pty.open`, under the rules in [§Error Codes](#error-codes).

### Workspace

| Code | Description | HTTP Status |
| --- | --- | --- |
| `workspace.not_found` | Workspace does not exist | 404 |
| `workspace.preparation_failed` | Preparing the workspace failed due to an internal error | 500 |
| `workspace.mode_unsupported` | A worktree was requested for a chat's managed workspace, which offers only its own root (Plan-007 D-007-5) | 400 |
| `workspace.stale` | Workspace execution root is unavailable; new write runs are blocked until repair ([Spec-007 §Fallback Behavior](../../specs/007-repo-attachment-and-workspace-binding.md#fallback-behavior); thrown by the Plan-007 `assertWritable` write gate, CP-007-3) | 409 |
| `workspace.execution_root_unresolved` | A repo-bound run reached the setup gate with no resolved execution root for the workspace's selected mode and root preparation failed; the run parks in `starting` ([Spec-008 §Fallback Behavior](../../specs/008-worktree-lifecycle-and-execution-modes.md#fallback-behavior); Plan-008 D-008-16) | 409 |
| `workspace.branch_name_required` | A wire-initiated (pre-run) `repo.executionRootPrepare` for a `provisioned-worktree` omitted `branchName`: the Spec-008 slug rule's derivation inputs (queue-item summary / run id) exist only on the run-setup gate path, so wire prepares must carry the branch. A `bound-root` prepare names no branch: the daemon follows whatever branch the checkout is on (Plan-008 D-008-19) | 400 |

### Repo

Repo-mount attach/detach/resolution errors (Plan-007 D-007-3). The `repo` namespace binds to the mount lifecycle; `workspace.*` binds to the bound-workspace lifecycle. `repo.root_resolution_failed` messages MUST NOT echo the attempted path (error-sanitization discipline; the daemon substrate's `sanitizeFields` is the second layer).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `repo.not_found` | Repo mount does not exist | 404 |
| `repo.root_resolution_failed` | Canonical repository root could not be resolved for the supplied path; attach fails explicitly rather than guessing ([Spec-007 §Fallback Behavior](../../specs/007-repo-attachment-and-workspace-binding.md#fallback-behavior)). `data.fields.reason: not_a_repository` when the folder is not in a git repository, drawn `Could not attach: not a git repository` | 422 |
| `repo.already_attached` | The resolved canonical root is already attached on this machine: a mount belongs to the machine, one per canonical root (Plan-007 D-007-7) | 409 |
| `repo.detach_conflict` | Detach refused while an agent runs anywhere in the project, naming the running session (drawn `Busy: <session> is running in it.`); active work must finish or be canceled first, and there is no force-detach ([Spec-007 §Detach Semantics (V1 Definition)](../../specs/007-repo-attachment-and-workspace-binding.md#detach-semantics-v1-definition)) | 409 |
| `repo.clone_refused` | `repo.clone` refused before anything is fetched. `data.fields.reason: destination_not_empty` when the destination exists and is not empty, drawn `<folder> is already there and is not empty.` ([Spec-007 §Required Behavior](../../specs/007-repo-attachment-and-workspace-binding.md#required-behavior)) | 422 |
| `repo.folder_unreachable` | `repo.attach` refused because the background service cannot reach the folder — on Windows, a folder inside another WSL 2 distribution than the one the service runs in — drawn `The background service cannot reach this folder. Pick one under your home folder or on a drive.` | 422 |

A clone that fails once git has started is a failure of the clone, not a refusal of a call, and carries no code: the clone card shows git's own last error line, which `repo.cloneSubscribe` carries as the clone's failure line ([Spec-007 §Required Behavior](../../specs/007-repo-attachment-and-workspace-binding.md#required-behavior)).

### Worktree

Worktree lifecycle errors (Plan-008 D-008-4). The `worktree` namespace binds to worktree rows. There is deliberately no `worktree.unsupported` code: a worktree that cannot be made surfaces as `worktree.create_failed`, and a worktree requested for a chat's managed workspace is refused with `workspace.mode_unsupported`. Failure messages MUST NOT echo attempted filesystem paths (error-sanitization discipline, same posture as §Repo).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `worktree.not_found` | Worktree does not exist | 404 |
| `worktree.create_failed` | Worktree creation failed (git error, filesystem error, or dynamic worktree unavailability at preparation time); the owning workspace transitions to `stale` via `failRootPreparation` and the failure detail rides `workspace.stale` metadata | 500 |
| `worktree.branch_collision` | Caller-supplied branch name collides with a live checkout on the same mount; user intent is never silently adapted — daemon-derived default names ordinal-suffix instead ([Spec-008 §Branch, Base And Preparation Rules](../../specs/008-worktree-lifecycle-and-execution-modes.md#branch-base-and-preparation-rules) collision policy) | 409 |
| `worktree.retire_conflict` | `repo.worktreeRetire` with `discard: false` refused. `data.fields.reason` is one of `root_busy` (an agent is running in the worktree) or `has_changes` (the tree holds something to lose that the confirm did not show — ignored files count — and the refusal carries the current risks so the confirm redraws them). `discard: true`, sent only after the discard confirm, is never refused for `has_changes` | 409 |

### Artifact

| Code | Description | HTTP Status |
| --- | --- | --- |
| `artifact.not_found` | Artifact does not exist | 404 |
| `artifact.too_large` | An ingest stream passed its own Init-declared total, enforced as its spool reservation and per-stream ceiling per the stream protocol's reservation rule: a chunk pushing the running decoded count past the declaration is this refusal with the spool deleted. An Init declaring more than the spool's volume can hold even with no other stream open, read from the disk at admission, which waiting can never admit, is this refusal too, naming the file and the room the disk has | 413 |
| `artifact.ingest_capacity_exhausted` | `AttachmentIngestInit` refused because the open-stream count has reached `max_active_ingest_streams` or the spool's volume, read at admission, has no room for this declaration beside the open streams' reservations — transient backpressure, retry later, **no stream state created** — no `ingestId` is minted, nothing is counted against `max_active_ingest_streams`, and no reservation held, so releasing one open stream admits the next Init; because the refusal issues no id, the zero-state property is observable through that next admission rather than through any identifier the caller could probe (admission is a serialized reserve-then-install section, so two concurrent Inits cannot both pass the bound). Deliberately distinct from the terminal `artifact.ingest_stream_invalid`: this one asks the caller to wait, that one to restart (reserved — registers with Plan-012 Task 11 per [Spec-012 §Ingest Validation And Payload Bounds (V1)](../../specs/012-artifacts-files-and-attachments.md#ingest-validation-and-payload-bounds-v1) stream protocol) | 429 |
| `artifact.ingest_stream_invalid` | An ingest stream call that cannot proceed and cannot be retried in place: a sequence gap, regression, or same-sequence different-bytes chunk (which terminates the live stream and deletes its spool), any call on a terminated or lifetime-expired stream, an unknown `ingestId`, or a `Chunk` on a completed stream. The remedy is restart from Init. **Two replays are deliberately NOT this code**, because a lost response must never cost the caller its upload: an **exact replay of the last acknowledged chunk** — same sequence, same bytes — is acknowledged idempotently without re-appending; and a **replayed `Complete` on a completed stream whose completion record is still held** replays that record's original response verbatim, re-running no pipeline step and minting no second manifest row (the carved exception; the record shares the stream registry entry's in-memory lifetime, so past `max_ingest_stream_lifetime` the same retry does receive this code) (reserved — registers with Plan-012 Task 11 per the same stream protocol) | 409 |
| `artifact.hash_mismatch` | Artifact content hash does not match the expected value | 409 |

**Two rows are reserved rather than live**, both in the ingest cohort: `artifact.ingest_capacity_exhausted` and `artifact.ingest_stream_invalid`. Both become live registrations with Plan-012's own legs when its phases reach them, each bound to one of that plan's assertions: the rows to Task 11's admission, sequencing and completion-record assertions, and `artifact.too_large` to Task 11's reservation assertion (a chunk exceeding its stream's Init-declared total).

### Workflow

Every refusal point of the workflow surface carries its own code, registered in its contract before the capability is implemented, and none ships unregistered ([Spec-015 §Loud-errors discipline (C-12)](../../specs/015-workflow-authoring-and-execution.md#loud-errors-discipline-c-12)). A state refusal is 409, well-formed input the daemon cannot act on is 422, and findings ride the error as an extension list. A refusal that names nodes is drawn on those nodes and leaves the draft editable.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `workflow.not_found` | Workflow definition does not exist | 404 |
| `workflow.gate_closed` | Workflow gate has not been resolved and blocks progression | 409 |
| `workflow.invalid_transition` | A run or step move its state does not allow, such as retrying a step that did not fail or reading results from an unfinished run | 409 |
| `workflow.start_denied` | Workflow run start refused by Cedar under `Action::"workflow::start"`: an agent's start, or a run a trigger fires, judged when it fires with the person recorded as its starter | 403 |
| `workflow.definition_refused` | A saved or imported document the daemon's own re-check refuses. `data.fields.findings` is the whole list, `[{rule, nodeIds, detail?}]`; `rule` is one of the values — `cycle`, `orphan`, `empty_document`, `trigger_missing`, `trigger_duplicate`, `edge_into_trigger`, `edge_out_of_terminal`, `param_missing`, `expression_unparsable`, `expression_unknown_node`, `expression_regex_unsupported`, `tool_edge_without_tool_input`, `handle_type_unknown`, `scope_ref_invalid`, `governance_inline`, `unknown_key` and `secret_outside_sensitive_field`. A Code step whose packages cannot be locked is not a finding: the save is kept, the node reads `Packages not locked` with the tool's own words, and that version cannot run until a later save locks it | 422 |
| `workflow.revision_stale` | A form submitted against a stale form revision | 409 |
| `workflow.version_stale` | A save against a stale definition version | 409 |
| `workflow.step_not_waiting` | A form submitted, an approval answered or a form read on a step that is no longer waiting | 409 |
| `workflow.retry_unavailable` | `Retry from this step` refused while the source run is still going. `data.fields.reason` is `source_running` | 409 |
| `workflow.code_packages_not_locked` | A run of a workflow version whose Code steps' packages are not locked refused at its start, drawn `Packages not locked` on each such node; `data.fields.nodeIds` names them. A later save that locks them makes the version runnable | 409 |
| `workflow.run_not_deletable` | `Delete run` on a run that is `new`, `running` or `waiting`, drawn `Cancel it first.`; nothing is deleted | 409 |
| `workflow.trigger_unarmable` | A trigger that cannot be armed | 422 |
| `workflow.webhook_token_mismatch` | A webhook call with the wrong token, or any call while no token exists | 403 |
| `workflow.import_schema_unknown` | An import whose schema version is unknown | 422 |
| `workflow.secret_name_invalid` | A secret name refused at save. `data.fields.reason` is one of `pattern` (the name breaks the pattern) or `taken` | 422 |
| `workflow.repair_not_parked` | Frozen-definition re-pin refused: the target run is not parked — a running instance is never re-pinned, unconditionally, per [Spec-015 §Frozen-definition repair (SA-41)](../../specs/015-workflow-authoring-and-execution.md#frozen-definition-repair-sa-41); the refusal is total, leaving the run unchanged on its original pinned version (registers with Plan-015 T5.12) | 409 |
| `workflow.repair_attempt_in_flight` | Frozen-definition re-pin refused: a step of the run is still in flight — the park's resume continues that step rather than starting it fresh (a usage-limit park by construction, which starts no new step), or a parked parallel branch holds a step that will continue later — so the refusal names the blocking step and the explicit fresh-start action that would discard it, instead of swapping the run-level definition pointer under steps already dispatched from the frozen bytes ([Spec-015 §Frozen-definition repair (SA-41)](../../specs/015-workflow-authoring-and-execution.md#frozen-definition-repair-sa-41), the run-wide fresh-start rule; refusal is total; registers with Plan-015 T5.12) | 409 |
| `workflow.repair_version_unaccountable` | Frozen-definition re-pin refused: the target version cannot account for the nodes the run has already completed — it omits a node whose outputs the run holds, or its graph would leave a completed node unreachable, which [Spec-015 §Frozen-definition repair (SA-41)](../../specs/015-workflow-authoring-and-execution.md#frozen-definition-repair-sa-41) states is one failure rather than two; refusal is total, leaving the run parked on its original version with its schedule state untouched (registers with Plan-015 T5.12) | 409 |
| `workflow.run_not_cancelable` | `workflow.runCancel` refused because the run already reached a terminal status — `succeeded`, `failed` or `crashed` — so there is nothing to cancel and reporting success would misinform the person about what their action did. Deliberately **not** the answer for a run already `canceled`: that call replays idempotently on the original `workflow.canceled` event with `alreadyCanceled: true`, minting no second status write and no second event, because a retried cancel must never cost the person a clear answer. Cancel is available on every `new`, `running` or `waiting` run, and a parked run is cancelable **without precondition** ([Spec-015 §Park integrity and cancelability (SA-42)](../../specs/015-workflow-authoring-and-execution.md#park-integrity-and-cancelability-sa-42)) (registers with Plan-015 T5.14) | 409 |
| `workflow.resume_not_parked` | `workflow.runResume` refused because the target run is not parked — there is no suspension to lift, so a resume would either be a no-op dressed as an action or a second dispatch of a running step. Distinct from `workflow.repair_not_parked`, which refuses the **re-pin leg** of a resume under [Spec-015 §Frozen-definition repair (SA-41)](../../specs/015-workflow-authoring-and-execution.md#frozen-definition-repair-sa-41): that code names a repair the run's state forbids, this one names a resume the run's state forbids, and collapsing them would leave the person unable to tell whether dropping the re-pin would have worked. Refusal is total; the run is unchanged. Resuming a parked run **ahead of** an armed `resumeAt` is not a refusal at all — the schedule is advisory pacing, the resume proceeds, and a still-spent provider account simply re-parks with its own `workflow.phase_suspended` (registers with Plan-015 T5.14) | 409 |

**Step failures.** These codes fail a step rather than refuse a call: each rides the step's `error` on its row and the `workflow.step_failed` event, for the life of the run record, and the run then takes the step's own error disposition. Their status column is notional.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `workflow.code_over_budget` | A Code node over its 256 MB memory limit | 422 |
| `workflow.code_install_failed` | A full-tier Code step whose package install did not finish. `data.fields`: `reason` (`disk_space` \| `tool_error`) and `detail`, `bun`'s or `uv`'s own error | 500 |
| `workflow.step_thread_failed` | A quick step's or an expression's thread that ended without an answer. `data.fields.reason`: `out_of_memory` \| `start_timeout` \| `exited` | 500 |
| `workflow.sandbox_unavailable` | A full-tier Code step, or a shell step at the Sandboxed level, whose provider sandbox did not start — `@anthropic-ai/sandbox-runtime` for Claude Code, `codex sandbox` for Codex. `data.fields`: `provider` (`claude-code` \| `codex`) and `detail`, the wrapper's own error. The step never falls back to running unprotected, and no other level is substituted for the one the run holds | 503 |
| `workflow.step_timed_out` | A step or a run cut by a time limit, read `failed · timed out`. `data.fields`: `cause` (`step_timeout` \| `run_cap`) and the limit | 504 |
| `workflow.secret_not_found` | A secret reference the keychain does not hold. `data.fields`: `reference` only. The step offers `Retry from this step` | 404 |
| `workflow.secret_store_unavailable` | The keychain is locked or unavailable. `data.fields.cause`: `locked` \| `unavailable`. The step fails with its cause and offers `Retry from this step`; it never waits indefinitely and never falls back to a plaintext value | 503 |

No code names a refused cancellation **of a parked run**, because a parked run is cancelable without precondition; cancel and resume check only the run's state. A park itself is a state transition rather than a caller-visible refusal.

### Driver

Driver codes ride the daemon JSON-RPC wire with notional HTTP statuses.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `driver.unavailable` | Provider driver is currently unavailable | 503 |
| `driver.capability_unsupported` | Requested capability is not supported by the driver. **Producers:** the `ProviderRegistry` pre-dispatch flag gate, the IPC layer's driver-implements-the-operation check, and a `driver.applyIntervention` **steer whose `attachments` list is non-empty**, refused **whole** at the single daemon ingress before any driver method runs. That third producer is the same fact as the other two: no V1 driver declares an attachment-delivery leg and no daemon seam yet resolves an `ArtifactId` to bytes, so the carrier the contract types cannot be honored — and the alternative is a supported steer answering `applied` after silently dropping every element, which is the loss the typed carrier exists to prevent. `data.fields` **depends on the producer and takes one of two wire shapes**, always carrying `driverId`: the registry's flag gate emits `{ driverId, flag }` (`flag` a `DriverCapabilityFlag`, forwarded unchanged by the IPC layer's driver-error translation), while the operation check and the attachment refusal emit `{ driverId, operation }` (`operation` a `ProviderDriver` method name — the attachment refusal takes this shape because no capability flag governs it, only the operation). A consumer reads whichever discriminating member is present and must not reject the other. It lifts when the daemon's attachment-reference resolver ships, at which point the arm is delivered rather than refused | 400 |
| `driver.timeout` | Provider driver operation timed out | 504 |
| `driver.cli_version_below_floor` | The provider CLI's reported version parsed and is below the per-driver minimum; capability read fails closed until the provider install is upgraded. A version the parser cannot read is never refused: the driver runs, keeping the printed version (`rawVersion`) without a parsed one ([Spec-004 §Required Behavior](../../specs/004-provider-driver-contract-and-capabilities.md#required-behavior) — distinct from `version.floor_exceeded`, the handshake's refusal of an app older than the service accepts, not a provider CLI install) | 409 |

### Provider Account

Refusals on the node-local provider accounts ([Spec-026](../../specs/026-provider-accounts-and-credential-homes.md)). Every one of these is **fail-closed**: the daemon refuses the run rather than falling back to ambient credentials, to a different account, or to an unvalidated home. A silent fallback here would execute against an account the person did not choose and bill spend to a party that never authorized it, so there is deliberately no permissive path.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `provideraccount.not_registered` | No account is registered for the requested provider; a provider run cannot be admitted. The remedy is registration, not a default — there is nothing to default to | 400 |
| `provideraccount.no_default` | Accounts exist for the provider but none carries the current mark, so resolution is ambiguous and refuses rather than picking one. A run never names its own account: the account is the one the session is on, moved only by `providerAccount.setCurrent` | 400 |
| `provideraccount.unknown` | The referenced `providerAccountId` is not present in the registry (never registered, or removed after the reference was taken) | 404 |
| `provideraccount.credential_home_unavailable` | The account's credential home is missing, unreadable, or structurally unusable; the run is refused rather than rebound to another account's home (I-026-8). Also the refusal when `providerAccount.setCurrent` names such an account: the current mark does not move, no running session moves, and every session stays on the account it was on ([Spec-026 §Moving a session to another account](../../specs/026-provider-accounts-and-credential-homes.md#moving-a-session-to-another-account)) | 503 |
| `provideraccount.not_authenticated` | `providerAccount.setCurrent` named a known-dead target: its stored reading is `reauth_required`, or its last limits read showed its Claude Code login gone (`rate_limits_available: false` with `subscription_type: null`). The press refuses in place and carries that account's own remedy: the current mark does not move and no session moves. No run is refused on its account's sign-in state; the session starts and a real sign-in failure arrives as the provider's own refusal | 401 |
| `provideraccount.permission_denied` | The caller is neither this machine's own client nor a linked device: a session asked for a registry verb (I-026-1) | 403 |
| `provideraccount.default_conflict` | A concurrent `providerAccount.setCurrent` lost the partial-unique-index race; the database refused the second writer rather than leaving two current accounts for one provider (I-026-5) | 409 |
| `provideraccount.signin_unsupported` | Brokered sign-in was requested for a provider whose pinned flow emits neither an authorization URL nor a device code, so there is nothing the person could act on. The daemon refuses rather than spawning a flow that cannot be completed; the remedy is the out-of-band sign-in the readiness handoff already discloses ([ADR-028](../../decisions/028-provider-credential-custody-posture.md) D1) | 400 |
| `provideraccount.signin_in_flight` | A brokered sign-in is already in flight for this account. Refused rather than started, because at least one pinned provider holds exactly one active login slot and **silently drops the previous attempt** — a permissive second start would strand the person mid-flow on another device with no signal that their code had stopped working. The remedy is `providerAccount.loginCancel` on the in-flight attempt | 409 |
| `provideraccount.credential_seal_refused` | The operating system's keychain would not take the token, so registration refuses and the token is stored nowhere else. `data.fields.cause` is one of `locked` (drawn `This machine's keychain is locked, so the token was not stored. Unlock it, then paste the token again.`) or `unavailable` (drawn `This machine has no keychain the app can store a token in, so the token was not stored. Use Sign in instead.`). Raised by the keychain alone: a Mac tells them apart by the keychain's own error (`errSecInteractionNotAllowed` is locked; `errSecNotAvailable` or `errSecNoSuchKeychain` is unavailable), and on Linux, where every entry opens the Secret Service explicitly, a locked collection is locked; where no Secret Service answers, the daemon keeps its items in one file in its own data folder, readable only by the person (mode `0600`) ([ADR-028](../../decisions/028-provider-credential-custody-posture.md)). The remedy is a host fix | 503 |
| `provideraccount.provider_version_below_floor` | The installed provider binary is older than the release that honors the reserved credential-home variables. Refused fail-closed rather than spawned, because a binary that ignores the pin would silently authenticate against the person's real home. The payload names the provider, the observed version, and the required floor, so the client can route the person to an upgrade rather than to re-authentication. | 409 |

`providerAccount.remove` is refused while sessions are on the account, naming those sessions so the person can move them first. Its code is the one `packages/contracts/src/provider-account.ts` registers with the verb, under the rules in [§Error Codes](#error-codes).

### Agent Definitions

Agent-definition and peer-invocation refusals (Plan-027; [Spec-027](../../specs/027-agent-definitions-and-peer-invocation.md)). Every code below is a **fail-closed** refusal: the daemon never substitutes a nearest-match model, a neighboring effort level, or a default provider account for one a definition pins, because silently running something other than what the definition names changes both behavior and price ([Spec-027 §Fallback Behavior](../../specs/027-agent-definitions-and-peer-invocation.md#fallback-behavior)). Definition mutation is node-local configuration, so these refusals emit no session event.

**The rows below are the definition-management refusals.** Peer invocation mints no code at all: [Spec-027 §Required Behavior](../../specs/027-agent-definitions-and-peer-invocation.md#required-behavior) requires every peer-invocation refusal to be answered on the callback-tool result's own `denied` / `failed` arms, so a call the approval pipeline declines, an unknown target, and a call that fails once it has started each reach the asking model as a tool result rather than as a JSON-RPC error.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `agent.definition_not_found` | No definition with the given `definitionId` exists on this node — from an `agent.*` definition mutation, or from a run that named it as the agent to run. **Never from a peer invocation**: an invocation naming an unknown definition answers on the callback-tool result's `failed` arm, per the paragraph above (`data.fields`: `definitionId`) | 404 |
| `agent.definition_name_conflict` | Requested definition name already exists, compared case-insensitively under full Unicode case folding ([Spec-027 §Required Behavior](../../specs/027-agent-definitions-and-peer-invocation.md#required-behavior); `data.fields`: `name`, `existingDefinitionId`) | 409 |
| `agent.definition_unreadable` | The definition registry could not be read: the library's own list read renders this refusal in place of its rows rather than an empty library, and a run that names a saved agent refuses rather than starting one the registry could not describe. A session whose own agent is already running is unaffected, so a storage fault on this table never blocks ordinary session work (`data.fields`: none) | 503 |
| `agent.resolution_refused` | The definition exists but cannot currently produce a runnable agent. `data.fields.reason` is one of `model_unavailable` \| `effort_unsupported` \| `account_unavailable` \| `allowlist_unrealizable` \| `provider_unsupported`, carrying the naming field its arm needs (`driverName` plus `modelId`, or `effort` plus the supported `effortLevels`, or `providerAccountId`, or the unrealizable `toolNames` plus the driver's `supportedToolNames`, or the provider name the definition's file carries). **The `provider_unsupported` arm** refuses starting a definition whose file names a provider this app doesn't run, until the person picks an installed provider in the editor; the name the file carries is kept, apart from the binding's `ProviderName`. **The `model_unavailable` arm answers two situations and names which by what it carries**: a model the definition pins that its provider no longer offers, carrying that `driverName` and that `modelId`; and a caller naming a driver the definition neither defaults to nor overrides while supplying no model of its own, carrying the requested `driverName` and a **null** `modelId`, which reads as "this definition binds no model for that driver". The arm is widened to say the second rather than a second code being minted, because the unresolvable thing is still the model, and the daemon never guesses one ([Spec-027 §Fallback Behavior](../../specs/027-agent-definitions-and-peer-invocation.md#fallback-behavior)). The fourth arm is not optional: [Spec-027 §Required Behavior](../../specs/027-agent-definitions-and-peer-invocation.md#required-behavior) requires the allowlist to be **enforced at spawn** rather than merely recorded, so an allowlist the resolved driver cannot realize must refuse here — an allowlist that is stored and not applied reports a restriction that does not hold. One code rather than five because the caller's situation and remedy are identical in every arm (edit the definition, or repair the account), while `reason` carries what to tell the person. **There is deliberately no account-_readiness_ arm**: `account_unavailable` fires on registry membership, a definite fact the resolver owns, while authentication state is settled at spawn by I-026-3's live probe and [Spec-026 §Node provider readiness and the sign-in handoff](../../specs/026-provider-accounts-and-credential-homes.md#node-provider-readiness-and-the-sign-in-handoff) makes the stored readiness projection advisory only against that gate — so a resolution-time refusal read off the stored projection would refuse a run the spawn gate would have admitted (`data.fields`: `definitionId`, `reason`, plus the arm's naming field(s) — two on `model_unavailable` (`driverName` plus `modelId`, the latter null where the definition binds no model for that driver), one on `account_unavailable`, two on `effort_unsupported` (`effort` plus the supported `effortLevels`), two on `allowlist_unrealizable` (the unrealizable `toolNames` plus the driver's `supportedToolNames`) and one on `provider_unsupported` (the provider name the file carries), each pair naming what was asked for beside what is available because neither alone tells the person what to edit) | 409 |
| `agent.export_write_failed` | `agent.definitionExport` could not write a definition's file into the chosen folder; `data.fields.cause` carries the operating system's cause | 500 |
| `agent.update_refused` | `agent.definitionUpdate` refused the change. `data.fields.reason` is one of `plugin_read_only` (the definition is a plugin's agent, which is read-only; its plugin is removed in `Browse plugins`) or `not_orphaned` (a reattach to a picked file named a record that is not orphaned) | 409 |

### MCP Governance

| Code | Description | HTTP Status |
| --- | --- | --- |
| `mcp.server_not_found` | No server with the requested `(provider, scope, scopeRef, serverName)` binding exists in the unified inventory — identity is per-provider and per-scope, so a same-named server on the other provider or in another scope does not match ([Spec-025 §Unified Inventory](../../specs/025-mcp-server-configuration-and-governance.md#unified-inventory)) | 404 |
| `mcp.config_invalid` | The submitted server configuration failed validation — malformed shape, unknown transport, or any refusal detectable **before the durable leg commits**; strictly pre-commit by contract: once the durable write has landed, per-leg live-application failures (including Claude `setMcpServers` per-server errors) report as `liveResults[]` entries on the successful response, never as this error, so a caller is never induced to retry a committed mutation ([Spec-025 §Configuration Mutation](../../specs/025-mcp-server-configuration-and-governance.md#configuration-mutation)) | 400 |
| `mcp.config_write_conflict` | A Codex config write lost to a concurrent edit, on either arm: a `user`-scope write failed optimistic concurrency twice — the `expected_version` write and the single silent re-read-and-retry both hit `configVersionConflict` — and the error carries both version tokens so the caller can re-inspect; or the `project` file no longer hashes to what the daemon last read, so the edit is not renamed into place and the file is left as it was ([Spec-025 §Configuration Mutation](../../specs/025-mcp-server-configuration-and-governance.md#configuration-mutation), [Spec-025 §Fallback Behavior](../../specs/025-mcp-server-configuration-and-governance.md#fallback-behavior)) | 409 |
| `mcp.oauth_flow_failed` | The daemon failed to **launch** the sign-in — discovery, registration, or the provider's own flow in its throwaway home — surfaced on the still-open `mcp.oauthLogin` call; strictly launch-phase: once the call has returned, an asynchronous completion failure is delivered as the `mcp.server_oauth_completed` event with `outcome: 'failure'` (observable on the `mcp.subscribe` stream), never as a late error on a completed call; the message never carries authorization URLs or credential material ([Spec-025 §OAuth Orchestration](../../specs/025-mcp-server-configuration-and-governance.md#oauth-orchestration)) | 502 |

### Skill

Skill-library refusals ([Spec-030](../../specs/030-skills.md)).

| Code | Description | HTTP Status |
| --- | --- | --- |
| `skill.path_refused` | `skill.update` refused a path in the folder it would save. `data.fields`: the path, and `reason` — `escapes_folder`, `duplicate_path` or `names_entry_file` | 422 |
| `skill.write_refused` | A write to a skill was refused. `data.fields.reason` is one of `plugin_read_only` (every operation that writes refuses a plugin's skill, which is read-only) or `not_orphaned` (`skill.recordReattach` named a record that is not orphaned) | 409 |

### Gitflow

The review and ship surface's refusals ([Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md)) are the codes `packages/contracts/src/gitflow.ts` registers with its verbs, each with its reason list, under the rules in [§Error Codes](#error-codes). A failed Generate, `gitflow.commitMessageGenerate` or `gitflow.changeRequestTextGenerate`, is refused with the provider's own words and never falls back to the other provider.

### Attention

Refusals of the delivery channels outside the app, the web address and the email digest ([Spec-017 §Cross-Device Delivery](../../specs/017-notifications-and-attention-model.md#cross-device-delivery)). The address, its signing secret and the mail password are on no reply, event, log or error, so no field here carries one.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `attention.delivery_store_unavailable` | The keychain holding a channel's secret is locked or unavailable. `data.fields.cause`: `locked` \| `unavailable`, the pair `workflow.secret_store_unavailable` carries | 503 |
| `attention.delivery_not_configured` | `attention.deliveryTest` for a channel that is not set up. `data.fields.missing`: `address` \| `password` | 409 |

### Relay

| Code | Description | HTTP Status |
| --- | --- | --- |
| `relay.connection_failed` | Relay connection to the upstream service failed | 502 |
| `relay.authentication_failed` | Relay authentication failed | 401 |
| `relay.spki_mismatch` | The machine refused a pinned relay whose key changed. The pin applies only to a relay whose certificate does not chain to a root the operating system trusts (a self-signed relay, or one on a private certificate authority); a relay with a publicly trusted certificate is checked by the platform's own validation and its host name, so a renewal never trips it. Recorded on the daemon's sentinel session as the `relay.pin_refused {relayHost, pinnedSpkiPrefix, presentedSpkiPrefix}` event, each prefix the first 8 bytes of its key's hash, never a token; the recovery is `sidekicks relay repin --force` with the new hash | 412 |
| `relay.replay_rejected` | A channel frame failed the Noise transport's decryption — a replayed, reordered or altered frame, since each frame's nonce is the sender's own count — so the receiving end closes the channel, and the next connection runs a fresh handshake. Counted in the relay block of `sidekicks daemon status`, never drawn | 409 |
| `channel.no_common_profile` | The machine runs none of the channel profiles a device's first frame offered, so it closes the connection with this code; nothing weaker is offered and there is nothing to fall back to. It rides no HTTP or JSON-RPC response: the status is notional | 426 |

A device and a machine share one channel, the Noise Protocol Framework's `Noise_KK_25519_ChaChaPoly_SHA256`, and a handshake from a key the account's statement chain does not trust simply fails, with nothing to click past: a machine answering under a known id with a new key and no later `runtimenode.added` for that id behind it is refused outright on the device. There is no session group and no per-session device cap: one channel carries every session on the machine, and the relay holds at most one connection per device key and one per machine key.

### Resource

Domain-level quota saturation: a create or an open that would pass a limit the daemon enforces. Distinct from §Transport, which is a peer mis-using the framing layer.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `resource.limit_exceeded` | A request would pass a daemon limit. `data.fields`: `resource` (the limit's name, such as `shells` for `pty.open` at the machine's shell limit or `shell write` for a `pty.write` over the daemon's bound), `limit` and `current`, all required. The screen says the limit was reached in words and draws no figure | 429 |

### Transport

Wire-level codes describing peer mis-use of the framing/handshake layer. Distinct from §Resource (which describes domain-level quota saturation): a transport failure is a peer behaving incorrectly toward the protocol substrate, not a session/run quota refusing additional creates.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `transport.unavailable` | The client cannot reach the daemon's OS-local socket or named pipe; no fallback transport exists | 503 |
| `transport.message_too_large` | Inbound frame's declared body length exceeded the 4 MB cap, or daemon-side outbound build exceeded it (Plan-006 Phase 2). 413 semantic. | 413 |
| `transport.invalid_protocol_version` | Per-request envelope-level `protocolVersion` field violates [Spec-006 §Wire Format](../../specs/006-local-ipc-and-daemon-control.md#wire-format): the field is missing, the wrong JS type, or fails the ISO 8601 `YYYY-MM-DD` shape. Substrate-side gate; fires BEFORE handler dispatch (I-006-7). Distinct from `version.floor_exceeded` / `version.ceiling_exceeded` (registry-side handshake-incompatibility) and from `protocol.version_mismatch` (registry-side mutating-op gate after handshake declared incompatible). 400 semantic. | 400 |

### System

| Code                    | Description                      | HTTP Status |
| ----------------------- | -------------------------------- | ----------- |
| `system.internal_error` | Unexpected internal error        | 500         |
| `system.maintenance`    | System is undergoing maintenance | 503         |

### Event

Event-replay cursor errors (Plan-005). Like the §Run / §Queue namespaces these ride the daemon JSON-RPC wire with the dotted code as the canonical `data.type` identifier; the HTTP status is the control-plane-notional mapping.

| Code | Description | HTTP Status |
| --- | --- | --- |
| `event.cursor_unresolvable` | An `EventCursor` submitted to `readAfterCursor` / `readWindow` cannot be decoded to a log position — `decodeEventCursor` rejects a non-integer or a value `< -1` (a UUID an SDK synthesized, a corrupted cursor) under the Plan-005 T4.3 predecessor-position cursor model (typed: `CURSOR_UNRESOLVABLE`) | 400 |

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

The relay counts requests on its sign-in routes only, and a refusal there returns the `RateLimitResponse` envelope with HTTP status 429; a counter error fails that one request like any backend error. The `resetAt` field provides the absolute timestamp (ISO 8601) when the rate limit window resets, complementing the relative `retryAfter` seconds value. Every refusal carries both timing fields, with the `Retry-After` and `X-RateLimit-Reset` headers ([Spec-019 §Overflow Response](../../specs/019-rate-limiting-policy.md#overflow-response)).

Every refusal on this envelope carries `code: "rate_limited"`. The relay's channel carries no rate limit: its per-connection backpressure slows a sender rather than refusing it.
