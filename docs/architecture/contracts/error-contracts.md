# Error Contracts

Canonical error shapes, error code namespaces, and standard error responses for the AI Sidekicks platform.

See also [API Payload Contracts](./api-payload-contracts.md) for the base `ErrorResponse` and `RateLimitResponse` types.

---

## Error Response Shape

All API errors use the canonical `ErrorResponse` envelope defined in API Payload Contracts:

```ts
interface ErrorResponse {
  code: string; // namespaced: 'session.notFound', 'auth.token.expired', etc.
  category: string; // the code's category (e.g. "notFound"), §Categories
  message: string; // human-readable description
}
```

A code's own fields sit beside `code`, `category` and `message`, as in `RateLimitResponse`, never under a nested member. The HTTP body carries the category as every refusal does, so a client acts on a code newer than itself the same way over either transport.

This shape is the **HTTP/control-plane** envelope (the control plane's HTTP routes, served by `axum` on `worker`). Local IPC traffic uses the JSON-RPC wire envelope declared in §JSON-RPC Wire Mapping below — the dotted-namespace `code` from this envelope rides as `data.type` on the JSON-RPC side. The two surfaces share the same project code registry (§Error Codes); only the framing differs.

---

## JSON-RPC Wire Mapping

Local IPC traffic (Plan-005 daemon ↔ in-tree clients) frames errors per [JSON-RPC 2.0 §5.1](https://www.jsonrpc.org/specification#error_object), which structurally requires `code` to be a Number. The dotted-namespace identifier (the canonical project code in §Error Codes below) rides in `data.type` and its category in `data.category`, per the [RFC 7807 Problem Details](https://datatracker.ietf.org/doc/html/rfc7807) precedent for structured error responses and the [LSP 3.17 ResponseError](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#responseError) field convention.

### Numeric Code Space (per JSON-RPC 2.0 §5.1)

| Numeric code | JSON-RPC name | Triggered by |
| --- | --- | --- |
| `-32700` | ParseError | Frame body is not valid JSON |
| `-32600` | InvalidRequest | JSON parses but the envelope or its framing is not a valid JSON-RPC Request (`connection.message.tooLarge`, `request.protocolVersion.invalid`) |
| `-32601` | MethodNotFound | Method is not registered against the dispatcher |
| `-32602` | InvalidParams | The params failed the method's contract check (`request.paramsInvalid`) |
| `-32603` | InternalError | The daemon's own fault: a result that failed its check, an unhandled failure or a programmer-error path (`request.resultInvalid`, `system.internalError`) |
| `-32800` | RequestCanceled | The client canceled the call with `$/cancelRequest` before the daemon reached its commit point |
| `-31000` | (application) | Every domain refusal: a well-formed call the daemon refuses on what it names or on the state it meets, whose code and category ride in `data` |

Only protocol outcomes take JSON-RPC's numbers; every domain refusal answers the one application number `-31000`, so the number never carries what `data.type` and `data.category` already say. An id or a row that resolves to nothing is a domain refusal of its owner's namespace at `-31000`, never `-32602`, its category most often `notFound`. The reserved range `-32768..-32000` is the JSON-RPC spec's prerogative, and the project mints no number inside it. `-32800` lies outside it and is LSP 3.17's `RequestCancelled`, the answer to `$/cancelRequest`. `-31000` lies outside it too, and outside the blocks LSP (`-32899..-32800`), MCP and A2A (`-32099..-32000`) claim.

### Categories

Every code carries one category from gRPC's canonical status codes (`google.rpc.Code`), written lowerCamelCase with American spelling, and the daemon sends it as `data.category`. The category says what a client can do; the code says exactly what happened. A client branches on `data.type`, falls back to `data.category` only for a code it does not know (a client older than the service it reaches meets codes newer than itself), and never reads the HTTP status for either.

| Category             | A client can                                                           |
| -------------------- | ---------------------------------------------------------------------- |
| `invalidArgument`    | Fix what it sent                                                       |
| `notFound`           | Stop naming the thing, or refresh its list                             |
| `alreadyExists`      | Pick another name or use the existing thing                            |
| `failedPrecondition` | Change the state first (finish, stop, sign in), then send again        |
| `aborted`            | Read again and retry: it lost a race or acted on an old version        |
| `unauthenticated`    | Get a valid credential                                                 |
| `permissionDenied`   | Nothing: this caller may not do this                                   |
| `resourceExhausted`  | Wait, or send less                                                     |
| `unavailable`        | Retry the same call later                                              |
| `unimplemented`      | Nothing here: this provider, account, model or build does not offer it |
| `deadlineExceeded`   | Retry; a deadline passed                                               |
| `canceled`           | Nothing: the caller canceled                                           |
| `internal`           | Report it: the service failed                                          |

Each code also keeps one hand-set HTTP status, set by what the code means and never derived from the category: 400 for a malformed request, 422 for a well-formed request refused on its meaning, 409 for a state conflict, 401 only for the caller's own credential. Only the control plane's routes and the workflow webhook listener send one; on every other code the status is notional, and a code only a JSON-RPC connection meets (`connection.handshake.required`, `connection.handshake.alreadyCompleted`, `connection.version.mismatch`, `connection.version.floorExceeded`, `connection.version.ceilingExceeded`, `auth.callerRefused`, `request.resultInvalid`, `request.canceled`, `terminal.write.limitReached`, `connection.call.limitReached`) has none.

### Two-Layer Envelope Shape

```ts
interface JsonRpcErrorEnvelope {
  readonly code: number; // one of the values above; the JSON-RPC §5.1 discriminator
  readonly message: string; // human-readable; sanitized at I-005-7 boundary (no stack/secret leak)
  readonly data?: {
    readonly type: string; // dotted-namespace project code (e.g. "session.notFound")
    readonly category: string; // the code's category (e.g. "notFound"), §Categories
    readonly fields?: Record<string, unknown>;
    // structured detail (e.g. { setting: "max_workers", value: -1 })
  };
}
```

The numeric `code` is the JSON-RPC spec-mandated discriminator. The `data.type` is the canonical project code — the same dotted-namespace strings the §Error Codes tables register — and `data.category` its category. Consumers MUST discriminate on `data.type` (not on `message`) for project-level error handling, reading `data.category` only for a code they do not know; `code` is for JSON-RPC-level discrimination only.

`data.fields` is optional structured detail. Producers MUST keep it free of sensitive content (no stack traces, no absolute paths, no secrets) per Plan-005 invariant I-005-7. The daemon's `mapJsonRpcError` substrate enforces I-005-7 a second time on the `data.fields` channel as defense-in-depth: every value passes through the daemon's field sanitizer (path redaction, length cap, width, depth and node-count caps) before the envelope is written. Producer discipline remains primary; the substrate is the safety net that survives a future builder forgetting to redact.

### Plan-005 Domain Identifiers

| `data.type` | JSON-RPC `code` | Category | Trigger |
| --- | --- | --- | --- |
| `request.methodNotFound` | `-32601` | `unimplemented` | The request names a method the daemon does not register; no handler runs |
| `request.paramsInvalid` | `-32602` | `invalidArgument` | The request's params failed the method's contract check, so no handler ran. Params that pass the check but name nothing the daemon holds are a domain refusal of the owner's namespace (§Numeric Code Space), and two workflow versions of different workflows are `workflow.version.diffCrossWorkflow` |
| `request.envelopeInvalid` | `-32600` | `invalidArgument` | The request's envelope breaks the wire format before dispatch: its `id` is over `JSON_RPC_ID_MAX_BYTES` once JSON-encoded, so the refusal carries `id: null` ([Local IPC Payload Contracts §JSON-RPC Request `id` Bound](./local-ipc-payloads.md#json-rpc-request-id-bound)); over HTTP, a body that does not parse or carries no JSON content type, or a body over the route's size limit, which answers 413 with `reason: tooLarge` |
| `request.resultInvalid` | `-32603` | `internal` | The handler's result failed the method's result check, or a transcript read's result does not answer the request it was given; a daemon fault, never the client's |
| `request.canceled` | `-32800` | `canceled` | A call the client canceled with `$/cancelRequest` before the daemon reached its commit point; the call still gets exactly one response |
| `connection.unavailable` | `-31000` | `unavailable` | The client cannot reach the daemon's OS-local socket or named pipe, or its link to the daemon is down; no fallback transport exists |
| `connection.message.tooLarge` | `-32600` | `resourceExhausted` | An inbound message passed the message cap on its JSON or on its attachments ([Spec-006 §Wire Format](../../specs/006-local-ipc-and-daemon-control.md#wire-format); the InvalidRequest classification of [Plan-005 §Phase 2: Wire Substrate](../../plans/005-local-ipc-and-daemon-control.md#phase-2-wire-substrate), T-005p-2-2): a framing error, answered with this error frame before the connection closes. A reply of the daemon's own past the cap closes the connection with no answer. It is a 413-semantic peer misframing of the wire layer, never a domain-level refusal. |
| `connection.subscription.limitReached` | `-31000` | `resourceExhausted` | A subscribe call found its connection already holding 10,000 open subscriptions, the backstop against a client that opens them in a loop; it may be sent again once one of them closes. A subscription costs the daemon only its place in the data, so no real use comes near it |
| `connection.call.limitReached` | `-31000` | `resourceExhausted` | A call found its connection already holding `MAX_CALLS_IN_FLIGHT` (100) calls in flight, refused at once and never run; a subscription cancel, a stop and a `terminal.write` take no slot. A client holds its calls past the cap and sends each as a slot frees, so only a client fault reaches it, and the client never sends it again |
| `request.protocolVersion.invalid` | `-32600` | `invalidArgument` | Per-request envelope-level `protocolVersion` field violates [Spec-006 §Wire Format](../../specs/006-local-ipc-and-daemon-control.md#wire-format): missing, wrong type, or fails the ISO 8601 `YYYY-MM-DD` shape. The substrate's one admission site, `ConnectionReader::admit` in `crates/sidekicks-daemon/src/ipc/local_gateway/connection.rs` (of `LocalGateway`), enforces it per I-005-6 BEFORE handler dispatch; the handshake (`connection.initialize`) is exempt because the negotiation parameter rides in `params.protocolVersion`. Distinct from `connection.version.mismatch` (NegotiationError, registry-side gate for incompatible negotiated versions on subsequent mutating ops): the wire-layer envelope shape gate fires once per request, the registry-side gate fires once-per-incompatible-mutating-op. |

`data.fields` shape per code:

- `request.methodNotFound`: none
- `request.envelopeInvalid`: over HTTP, `{ reason: "tooLarge" }` for a body over the route's size limit, answered 413; otherwise none
- `request.paramsInvalid`: `{ issues }`, the failed check's issues, each with its `path` and `message`, absent when the list is empty
- `request.resultInvalid`: `{ issues }`, the result's failed checks in the same form, absent when the list is empty
- `request.canceled`: none
- `connection.unavailable`: for a socket the client cannot reach, `{ reason }`, one listed reason (`ConnectionUnavailableReason` in `crates/sidekicks-contracts/src/jsonrpc/message.rs`, its generated TypeScript at `packages/contracts/src/jsonrpc/message.ts`): `notListening` when nothing answers on it (the system's `ENOENT` or `ECONNREFUSED`, `io::ErrorKind::NotFound` or `ConnectionRefused`), `accessDenied` when the client may not open it (`EACCES`, `EPERM`, `io::ErrorKind::PermissionDenied`) and `unreachable` for any other socket failure. The system's own error code never rides in `reason`. A link that is down carries no `fields`
- `connection.message.tooLarge`: `{ limit: number, observed: number }`
- `connection.subscription.limitReached`: `{ limit: number }`
- `connection.call.limitReached`: `{ limit: number }`
- `request.protocolVersion.invalid`: `{ reason: "missing" | "wrongType" | "invalidFormat", observedType?: string }` (`observedType` is the offending value's JSON type, as the gateway writes it: `"null"` for `null`, `"object"` for an object or an array, else `"boolean"`, `"number"` or `"string"`; present only when `reason === "wrongType"`; the offending VALUE itself is NOT echoed back so client-supplied content does not leak through observability)

### Negotiation Refusals

`NegotiationError` refusals (the gate-refusal codes in `crates/sidekicks-ipc/src/protocol_negotiation.rs`) and `ConnectionInitializeResponse.reason` strings (the handshake-incompatible reasons in `crates/sidekicks-contracts/src/jsonrpc/negotiation.rs`) all map through the same envelope. The reason strings are canonicalized to dotted-namespace form:

| `data.type` | JSON-RPC `code` | Category | Surface | Trigger |
| --- | --- | --- | --- | --- |
| `connection.version.floorExceeded` | n/a (ConnectionInitializeResponse.reason field) | `failedPrecondition` | ConnectionInitializeResponse | Client below daemon's lex-min supported version |
| `connection.version.ceilingExceeded` | n/a (ConnectionInitializeResponse.reason field) | `failedPrecondition` | ConnectionInitializeResponse | Client above daemon's lex-max supported version |
| `connection.handshake.alreadyCompleted` | n/a (ConnectionInitializeResponse.reason field) | `failedPrecondition` | ConnectionInitializeResponse | Second `connection.initialize` on a connection with latched outcome, carrying the session token, or none on a connection its caller's signature admitted |
| `connection.handshake.required` | `-31000` | `failedPrecondition` | NegotiationError | Any method but `connection.initialize` dispatched in `pre` state (I-005-1) |
| `connection.version.mismatch` | `-31000` | `failedPrecondition` | NegotiationError | Mutating dispatch attempted in `done-incompatible` state ([Spec-006 §Fallback Behavior](../../specs/006-local-ipc-and-daemon-control.md#fallback-behavior)) |
| `auth.token.invalid` | `-31000` | `unauthenticated` | NegotiationError | `connection.initialize` without the daemon's session token or with a wrong one, unless on macOS it carries no token and comes from the desktop's signed client helper; the connection is latched refused, so every later call on it gets the same refusal, a second handshake included, even one sent while the first's caller was still being checked. A second handshake on an admitted connection that carries a wrong token, or none on one the token admitted, is refused with it too, and the connection stays as latched |
| `auth.callerRefused` | `-31000` | `permissionDenied` | NegotiationError | `connection.initialize`, with any token or none, from a process the daemon itself started outside the person's terminals (on macOS, one the system holds the daemon responsible for), such as a command an agent ran, from one a provider service the daemon holds a connection to started, or from one the system could not name or trace; the connection is latched refused as for `auth.token.invalid` |

### Test-Side Discrimination

Test code asserting on JSON-RPC error envelopes MUST discriminate on `data.type` for project-level expectations and on `code` for JSON-RPC-level expectations, and asserts the whole envelope:

```rust
let envelope = serde_json::to_value(&error).expect("an error envelope serializes");
assert_eq!(envelope["code"], -32602);
assert_eq!(envelope["message"], "the params break the method's contract");
assert_eq!(envelope["data"]["type"], "request.paramsInvalid");
assert_eq!(envelope["data"]["category"], "invalidArgument");
assert!(envelope["data"]["fields"]["issues"].is_array());
```

---

## Error Codes

Every namespace below follows the same rules:

- **One code per refusal.** A code names one refusal a caller can act on, and that refusal has exactly one code; no code is a second name for another.
- **Listed reasons.** Where one refusal has several causes, the code carries `data.fields.reason` from a list registered with the code, never free text.
- **The owner's namespace.** A code sits under the domain whose operation refuses and follows the wire grammar of [Local IPC Payload Contracts §Wire-Name Grammar](./local-ipc-payloads.md#wire-name-grammar), `domain[.resource].condition`, the condition last and the resource left out where the domain is itself what is refused (`session.notFound`).
- **One category and one status.** Each code carries one category (§Categories), sent as `data.category`, and one hand-set HTTP status; a code whose causes would need two categories is two codes.
- **No structure prefixes.** A root names that domain, never the layer, process or pane a refusal passes through.
- **Current words only.** A code uses the product's current words and names only a concept the product has.
- **Registered before it is raised.** The unit that builds a capability registers that capability's codes and their reason lists in its contract in `crates/sidekicks-contracts` before the capability is implemented, never while implementing it, and each section below lists what its contract registers. No refusal ships without a registered code.

### Session

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `session.notFound` | Session does not exist | `notFound` | 404 |
| `session.alreadyClosed` | Session has already been closed and cannot be modified | `failedPrecondition` | 409 |
| `session.permissionLevel.notOffered` | A permission level the session's provider, its account or its model cannot run, sent on `session.permissionLevel.update` or as `plan.resolve`'s `fresh.level`. The screen never offers such a level, so only a stale or raced client sends one; nothing changes and no session is minted ([Spec-010 §Interfaces And Contracts](../../specs/010-approvals-permissions-and-trust-boundaries.md#interfaces-and-contracts); `data.fields`: `level`) | `invalidArgument` | 422 |
| `session.attachment.refused` | A file `session.attachment.add` did not stage. It rides per item, as the `cause` of one entry in the reply's `refused` list (`{code, reason}` with the members named below, or an `artifact.*` code) beside the files that were staged, never as the call's error. `reason` is one of `countLimit` (the message already carries as many files as the provider takes), `folder` (a folder was offered; an agent reads a folder where it is), `providerTakesNoAttachments` (the session's provider accepts no files), `cardWaiting` (a card above the composer is waiting on the person), `providerRefused` (the provider's own limit or its refusal of a picture, carrying the provider's words) or `copyFailed` (the copy to the daemon did not complete, carrying the daemon's own cause). A file the free disk cannot hold rides the same list as `artifact.tooLarge`, naming the room the disk has, and one that only waits on files already being taken as `artifact.ingest.capacityExhausted` | `invalidArgument` | 422 |
| `session.group.nameTaken` | `session.group.create` or `session.group.rename` named a group another group of the session's project already holds, ignoring case; nothing is written | `alreadyExists` | 409 |
| `session.group.refused` | `session.group.create`, `session.group.move` or `session.create`'s `groupId` asked to put a chat in a group, or a session in a group of another project; nothing is written | `invalidArgument` | 422 |
| `session.link.notRemovable` | `session.link.remove` named a link the daemon wrote from an event (`started`, `copiedFrom`, `messaged`, `asked`, `mentioned`), which records what happened; only a `related` link is removed | `failedPrecondition` | 409 |
| `session.conversion.refused` | `session.convert` named a session that is not a chat, a chat with no managed workspace to convert (`data.fields.reason: noManagedWorkspace`), a `clientIdempotencyKey` another session's conversion holds (`reason: idempotencyKeyReused`), a folder other than the one a chat's stopped conversion copies into (`reason: conversionUnfinished`, with that conversion's `repoMountId`), or a folder outside the chat's place, which never changes (`reason: folderInAnotherPlace`, with the chat's `place`), drawn in place in the convert flow `This chat runs in Ubuntu, so its project folder must be in Ubuntu too.` or `This chat runs on Windows, so its project folder must be on Windows too.`; nothing is attached or copied | `failedPrecondition` | 409 |
| `session.conversion.incomplete` | A conversion stopped after the repository was attached; the session still reads as a chat, and `data.fields` names what was done: `sessionId`, `repoMountId`, `copiedCount`, `skippedCount`, `isBound`. A convert naming the same folder, under any key, resumes it from what it recorded | `internal` | 500 |
| `session.changeRefused` | A change the session's state does not take: a `provisioning` session is neither archived, closed nor converted, and a `purgeRequested` one, being deleted, takes no change; nothing is written (`data.fields`: `sessionId`, `state`) | `failedPrecondition` | 409 |
| `session.reviewNote.notFound` | Raised by `session.reviewNote.update` and `session.reviewNote.add`. An update named a note the session does not hold: it was sent as a steer or discarded, perhaps on another device, and nothing is written. An add found its new note discarded from another device before it could answer it. `data.fields.noteId` names the note | `notFound` | 404 |
| `session.search.cursorUnresolvable` | A `session.search` `afterCursor` the daemon did not write, one written for another query, or one whose search the daemon no longer holds; nothing is answered | `invalidArgument` | 400 |
| `session.workingFolder.missing` | A `session.file.search` whose session has no working folder in place, yet or any more, nothing being listed, or a `session.workingFolder.update` whose session works in no folder any more, nothing being moved. Also a `terminal.open` whose session's working folder is not ready yet or is gone; no shell starts (`data.fields`: `sessionId`) | `failedPrecondition` | 409 |
| `session.rebuilding` | A write to a session the restart's recovery pass has not yet rebuilt and settled the runs of, at the wire for a call naming the session and at the append for any of its events but the pass's own; every other session takes writes, and the same write succeeds once the pass reaches it. `session.recovery.continue` and `session.recovery.delete` are never refused this way. `data.fields`: `sessionId` | `unavailable` | 503 |
| `session.history.damaged` | A write to a session whose history is degraded (at its last good point) or damaged (no readable event), at the wire and at the append as for `session.rebuilding`; the person picks `Continue from here` or `Delete session` first. `session.recovery.continue` and `session.recovery.delete` are never refused this way. `data.fields`: `sessionId`, and `recovery`, the session's state on `daemon.status.read`, `degraded` \| `damaged` | `failedPrecondition` | 409 |
| `session.recovery.refused` | `session.recovery.continue` or `session.recovery.delete` named a session the refusal does not fit; nothing is written. `data.fields`: `sessionId`, and `reason`, `notDamaged` (the session's history is not damaged) or `noReadableEvent` (`Continue from here` on a session with no readable event, which offers `Delete session` only) | `failedPrecondition` | 409 |
| `session.message.tooLarge` | A message, a steer or a queued message the session's provider refused as longer than its own limit, raised by `agent.queueItem.create` and `agent.childRun.steer` (Codex: 1,048,576 characters of text, pictures and files uncounted, per [the Codex wire reference](../../reference/provider-wire/codex.md#refusal-shapes-on-the-client-request-channel)); nothing of it reaches the conversation, and the message is handed back as a failed send, its words and attachments back in the composer. `data.fields`: `limit` and `observed`, in characters | `resourceExhausted` | 413 |

### Auth

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `auth.token.expired` | Authentication token has expired; answered with `WWW-Authenticate: DPoP algs="ES256", error="invalid_token"` | `unauthenticated` | 401 |
| `auth.token.invalid` | Authentication token is missing, malformed, invalid or revoked; answered with `WWW-Authenticate: DPoP algs="ES256"`, with `error="invalid_token"` when a token was presented | `unauthenticated` | 401 |
| `auth.insufficientScope` | Token does not have the required scope for this operation | `permissionDenied` | 403 |
| `auth.dpopMismatch` | A DPoP proof that is missing, malformed, replayed, or does not match the bound token; answered with `WWW-Authenticate: DPoP algs="ES256"` and `error="invalid_dpop_proof"` for a refused proof, or `error="invalid_token"` for a token bound to another key | `unauthenticated` | 401 |

### Agent Run

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `agent.run.invalidTransition` | Requested state transition is not allowed from the current run state | `failedPrecondition` | 409 |
| `agent.run.versionStale` | An `agent.run.pause` or `agent.run.resume` whose `expectedRunVersion` is not the run's current version, older or newer; nothing is written and the run is left as it was | `aborted` | 409 |
| `agent.run.notChild` | A read of a child run's rows named a run that has no parent | `failedPrecondition` | 409 |
| `agent.run.notFound` | Run does not exist | `notFound` | 404 |
| `agent.run.recoveryFailed` | Run recovery failed due to an internal error | `internal` | 500 |
| `agent.childRun.controlRefused` | A control on one named child of a run — `agent.childRun.steer`, `agent.childRun.interrupt` or `agent.childRun.paused.update`, or a queue verb carrying `childHandle` — refused. `data.fields.reason` is `childEnded` (the child has already ended) or `providerRefused` (the provider declined the control). A child the daemon bridges is its own run and is controlled through that run's own verbs; a lost hold is a result on the reply, never this refusal | `failedPrecondition` | 409 |
| `agent.childRun.notFound` | A control on one named child of a run, or a queue verb carrying `childHandle`, whose handle names no child of this run; nothing is sent | `notFound` | 404 |

`agent.run.create` registers no code of its own (Plan-013 D-013-11): refused at admission, it answers with a reused code, §Agent `agent.notFound`, or §Agent Run `agent.run.notFound` where the parent run is missing. Every such refusal is zero-residue — no run row, no queue item, no partial state survives it (I-013-7) — and the daemon records it durably as the `agent.run.rejected` event ([Spec-014 §Example Flows](../../specs/014-multi-agent-orchestration.md#example-flows) "records the refusal visibly"). A reached spend limit is not a refusal: a message sent while it stands lands with the `Spend limit reached` row under it and starts no turn ([Spec-014 §Budget Policies](../../specs/014-multi-agent-orchestration.md#budget-policies)).

### Agent Queue Item

Daemon-local agent queue control codes (Plan-002). Run-control authority is daemon-only ([ADR-003](../../decisions/003-daemon-backed-queue-and-interventions.md)), so — like the `agent.run.*` codes — these ride the daemon JSON-RPC wire with the dotted code as the canonical `data.type` identifier and the HTTP status as the control-plane-notional mapping; no separate §JSON-RPC numeric pin (the `agent.run.*` domain-code convention).

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `agent.queueItem.persistenceUnavailable` | New queued run-control work was rejected fail-closed because the daemon's queue-persistence layer is unavailable (Plan-002 I-002-1 / ADR-003 — block new queued work when persistence is unavailable) | `unavailable` | 503 |
| `agent.queueItem.notFound` | A change (`agent.queueItem.cancel`, an edit through `agent.queueItem.create` with `replacesQueueItemId`, or `agent.queueItem.reorder`) named a queue item the queue does not hold: an id it never stored, an item of another session, or one of another queue than the call names | `notFound` | 404 |
| `agent.queueItem.changeRefused` | A change to a waiting message refused: a removal (`agent.queueItem.cancel`) or an edit (`agent.queueItem.create` with `replacesQueueItemId`) of a message the agent has already taken, a removal or an edit of one Claude Code did not give back, its withdraw failing or passing the daemon's ten-second withdraw deadline, which then reads not delivered, or an `agent.queueItem.reorder` whose list is not exactly the waiting items. `data.fields.reason` is `alreadyTaken`, `notDelivered` or `orderMismatch` | `failedPrecondition` | 409 |
| `agent.queueItem.runChanged` | A send (`agent.queueItem.create`) whose session's lead run started, ended or was continued between each read of it and the write that sends into it, every time the daemon tried; nothing is queued, and the send can be made again | `aborted` | 409 |

### Agent Intervention

Intervention request-admission codes ([Spec-004 §Required Behavior](../../specs/004-provider-driver-contract-and-capabilities.md#required-behavior)). Intervention **outcomes** deliberately resolve via the seven-state lifecycle (`rejected` / `expired` / `degraded` / `failed` are states, not error codes — [queue-and-intervention-model.md §Driver Result To Lifecycle Mapping](../../domain/queue-and-intervention-model.md#driver-result-to-lifecycle-mapping)); this namespace covers only request-level refusals that never produce an intervention row. The token deliberately collides with no `agent.intervention.*` durable event name (`requested`/`accepted`/`applied`/`rejected`/`degraded`/`expired` — the never-collide rule, D-009-4 convention).

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `agent.intervention.idempotencyConflict` | A `clientIdempotencyKey` was reused with a differing payload; the original intervention is untouched and the conflicting request is refused (an identical retry is not an error — it returns the saved result). Semantic payload conflict per the converging idempotency-key practice (`data.fields`: `targetRunId`, `interventionId` of the original) | `invalidArgument` | 422 |

### Agent Command

Refusals of the operations on a run's running commands ([Running Command Payload Contracts](running-command-payloads.md#running-command-method-registry-plan-003)). A move to the background on a provider with no such move refuses as §Provider `provider.capability.unsupported`.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `agent.command.notInForeground` | `agent.command.background` named a command no turn is waiting on in the foreground; nothing moves | `failedPrecondition` | 409 |
| `agent.command.takesNoInput` | `agent.command.write` named a command that neither takes input nor has a prompt open; nothing is written | `failedPrecondition` | 409 |

### Question

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `question.answersIncomplete` | A `question.resolve` whose list does not answer every question of the record; nothing is answered and the question stays open ([Spec-011 §Interfaces And Contracts](../../specs/011-transcript-and-reasoning.md#interfaces-and-contracts)) | `invalidArgument` | 422 |
| `question.answerInvalid` | A `question.resolve` answer its question cannot take; nothing is answered or sent and the question stays open. `data.fields.page` names the question and `data.fields.reason` how: `secretOnPlain` (a secret for a question that is not secret, or anything but a secret or a skip for one that is), `labelNotOffered` (a label the question does not offer), `severalOnSingle` (several labels for a question that takes one) or `textOnChoice` (typed text for a form field whose options are its only values) | `invalidArgument` | 422 |
| `question.notFound` | `question.resolve` named a question the daemon holds no record of | `notFound` | 404 |
| `question.notWaiting` | `question.resolve` named a question its agent does not wait for, which a message sent through the queue answers; nothing is answered | `failedPrecondition` | 409 |
| `question.waitingForRun` | `question.resolve` named a question that waits for its run to read running, shown greyed under `Waiting for the run`; nothing is answered and it opens once the run reads running | `failedPrecondition` | 409 |

### Agent

Agent-surface codes (Plan-013 D-013-11; the provider axis, D-013-17).

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `agent.notFound` | Agent does not exist in the session (`data.fields`: `agentId`) | `notFound` | 404 |
| `agent.providerAxisInvalid` | A provider-axis member on `agent.config.update`, or in `session.create`'s binding, names something the machine cannot honor: an unregistered driver, a model absent from what `provider.model.list` lists for the target driver, an effort absent from that model's `effortLevels`, a larger window (`AgentProviderBinding.largerWindow`) the target model's catalog does not offer at that figure, which the picker never offers, so only a stale or raced client sends one, an output-speed value absent from the `outputSpeedLevels` published for the target model (its own list where its provider publishes one per model, else the driver's), or a session option (`options`) the target driver does not declare in its `sessionOptions`, whose value lies outside the target driver's declaration of it (`ProviderSessionOption`), or that the provider reports this session cannot run (`ObservedProviderOption.isAvailable` false) ([Spec-014 §Same-Agent Provider Switch](../../specs/014-multi-agent-orchestration.md#same-agent-provider-switch)). Refused **before** any turn is started on the target, so a rejected switch spends nothing, and a refused create makes no session. A driver that reads its provider's live catalog when it starts the session, and finds the value no longer offered there, refuses with it too, naming the agent. `data.fields`: `agentId`, `axis` (`providerName` \| `modelId` \| `largerWindow` \| `effort` \| `outputSpeed` \| `options`), `value`. The axis names are the member names of the request, so this discriminator **is** the `AgentProviderAxis` union in [orchestration-payloads.md §Plan-013](./orchestration-payloads.md#plan-013--multi-agent-orchestration) rather than a second spelling of it: one axis vocabulary, every member of which this refusal can name. The `outputSpeed` arm is **vocabulary validation and nothing else**: it covers a target model whose published `outputSpeedLevels` is absent or empty — which makes the axis unsettable — and a value outside a vocabulary that was published. It deliberately does **not** cover a driver declaring `outputSpeed: false`, which is the axis not existing on that provider rather than a bad value in it, and which refuses as the already-registered `provider.capability.unsupported` on the ordinary capability gate ([Spec-004 §The output-speed axis](../../specs/004-provider-driver-contract-and-capabilities.md#the-output-speed-axis), [Spec-014 §The mutation surface](../../specs/014-multi-agent-orchestration.md#the-mutation-surface), and Plan-013 T2.8's validation leg all order it capability-check-then-value-check). Two canonical refusals for one request would leave implementers and clients to pick, so the gate that runs first owns the refusal. Both arms still refuse fail-closed before any unvalidated setting reaches a provider spawn. It does not cover an accepted switch that later could not be applied, which reaches the caller as the `agent.providerBinding.changeFailed` event's own `outputSpeedUnavailable` reason instead; the two vocabularies stay separate for the reason [Spec-005 §Agent Lifecycle](../../specs/005-session-event-taxonomy-and-audit-log.md#agent-lifecycle-sessionlifecycle) already states. A switch that fails after it was accepted leaves the agent on its previous binding and lands one system message, with `Sign in again` only where the reason is `accountUnavailable` and the account's state is `reauthRequired`. **Which account pays is not an axis of this request at all**, so no arm here names one: the account a session runs on moves on the provider surface through `provider.account.current.update` ([Spec-025 §Moving a session to another account](../../specs/025-provider-accounts-and-credential-homes.md#moving-a-session-to-another-account)), and an unregistered or unknown account refuses in the provider-account namespace (`provider.account.notFound` / `provider.account.notRegistered`), which is both the owner of that fact and the refusal [Spec-025 §Fallback Behavior](../../specs/025-provider-accounts-and-credential-homes.md#fallback-behavior) names for a provider with no registered account. A second answer to one question here would route the person nowhere | `invalidArgument` | 422 |

### Approval

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `approval.notFound` | Approval request does not exist | `notFound` | 404 |
| `plan.notFound` | `plan.resolve` named a plan the daemon holds no record of | `notFound` | 404 |
| `approval.alreadyResolved` | Approval request has already been resolved | `failedPrecondition` | 409 |
| `approval.requestCanceled` | Approval request was canceled (its run ended — an interrupt among the ways it can — its session closed, the provider process ended, or its originating provider ask was retracted before resolution — Plan-009 T2.8's live-leg cancel ingress) and can no longer be resolved; also the late-CREATE refusal — a create arriving for an already-ended run or already-closed session (Plan-009 T2.12). The **late-CREATE refusal shape** carries a typed `reason` extension member — `'runEnded' \| 'sessionClosed'` — per RFC 9457 §3.2 extension-member practice, derived from live terminal state at refusal time (a retraction can never cause a late CREATE — the request already exists when a retraction settles it); the resolve-path 409 for an already-canceled request carries no `reason` (the cancellation cause is not persisted on `approval.canceled` — audit reconstructs it from the adjacent run/session terminal rows on the transcript) | `failedPrecondition` | 409 |
| `approval.resolutionInvalid` | `approval.resolve` sent an answer its request cannot take, and nothing was recorded; `data.fields.reason` names how: `blockOutsideNetworkAccess` (a block rule on a request that is not `networkAccess`), `ruleNotOffered` (a rule on a request that offers none, or a project rule where only a session rule is offered), `subjectMismatch` (a rule whose subject is not the one the daemon derived for the card), `editNotOffered` (a corrected command or path on a request whose card offers no correction), `editWithRule` (a correction sent with a rule, which would name a subject the card never showed) or `effectiveScopeBroader` (a scope other than the request's own, which is the only one the daemon can show is no broader) | `invalidArgument` | 422 |
| `approval.persistenceUnavailable` | A permission check or approval mutation was rejected fail-closed because the daemon's approval-persistence layer is unavailable ([Spec-010 §Fallback Behavior](../../specs/010-approvals-permissions-and-trust-boundaries.md#fallback-behavior) — the sensitive action must not proceed) | `unavailable` | 503 |
| `approval.rule.notKept` | `approval.resolve` recorded the answer and the provider took it, so the call runs or is refused on it, but the provider could not keep the rule the answer asked for (it refused the settings update, or its rule file could not be written), so no rule was made and the resolution records no remembered scope; or `approval.rule.revoke` or `mcp.server.delete` could not take a rule out of a project's rule file (the file is not one the daemon edits, or it could not be written), so the rule still applies there | `internal` | 500 |
| `approval.rule.notFound` | Approval rule does not exist where the provider keeps it | `notFound` | 404 |
| `approval.rule.alreadyRevoked` | Approval rule has already been revoked | `failedPrecondition` | 409 |
| `approval.denial.notFound` | `approval.denial.override` names a `denialId` the daemon holds no block for | `notFound` | 404 |
| `approval.denial.notOverridable` | `approval.denial.override` names a block the provider's own reviewer marked not overridable (`overridable: false`), so no person can overrule it | `failedPrecondition` | 409 |

**No code names an expired request, because a request never expires.** An approval waits until it is answered; moving the session's permission level neither answers nor cancels an open request, which stays for the person, and the only cancellations are an interrupt or any other end of its run and the provider process ending, so `approval.requestCanceled` is the only cancellation code. That token deliberately differs from the Spec-005 durable event name `approval.canceled` so an error code never collides with an event name (the never-collide rule of §Agent Intervention). No `approval.permissionDenied` code exists: nothing checks which of the person's devices answers, `PermissionCheck` denial is a normal `allowed: false` response rather than an error, and a session belongs to one person.

### Account

The hosted account's sign-in refusals, raised by the service's local `account.signIn` ([Hosted Account Payload Contracts §Account Sign-In Method Registry](./hosted-account-payloads.md#account-sign-in-method-registry); Plan-015 T5.4). No `data.fields`. A sign-in the relay cannot be reached for is refused with [`relay.connectionFailed`](#relay); a failed attempt is no refusal but an outcome `account.signIn.subscribe` reports, with one reason from its closed set.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `account.alreadySignedIn` | `account.signIn` on a machine already signed in to the hosted account; nothing starts. A sign-in still waiting is no refusal: a new `account.signIn` replaces it | `failedPrecondition` | 409 |
| `account.relay.notConfigured` | `account.signIn` on a machine with no relay address set and none given in the request, so there is no relay to sign in at; the same request succeeds once one is set | `failedPrecondition` | 409 |
| `account.relay.addressInvalid` | The `relayAddress` given to `account.signIn` is not a relay address; nothing is set and no sign-in starts. Drawn under the Devices page's `Relay address` field as `That is not a relay address.` | `invalidArgument` | 422 |

### Account Passkey

WebAuthn-ceremony refusals (Plan-015 Phase 6). Both codes are served on **control-plane routes** rather than a daemon `account.*` method — the web client and the iPhone app call them, the authentication pair and account creation's registration with no sign-in and the rest signed in, the relay's sign-in page at `/oauth/authorize` answers them too, and the desktop app carries no WebAuthn — so they carry no §JSON-RPC pin.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `account.passkey.challengeInvalid` | The WebAuthn ceremony challenge presented at verification is unknown, already consumed, or expired — challenges are single-use and short-lived, consumed atomically by the fence's `DELETE ... RETURNING` (Plan-015 T6.4 / I-015-6). Domain validation code. | `invalidArgument` | 400 |
| `account.passkey.verificationFailed` | A WebAuthn registration or assertion response failed verification. Deliberately **one** code for every arm — bad signature, wrong origin, wrong `rpId`, unknown credential, a missing or foreign user handle, regressed signature counter, and a response whose user-verified flag is absent — so the reply is no oracle for which check failed (Plan-015 T6.2 / T6.3 / I-015-7). Domain validation code. | `invalidArgument` | 400 |

### Machine

`machine.permissionDenied` is registry-only (code and message, with no fields of its own): no acceptance criterion needs structured detail, and a detail naming the machine would say whether it exists.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `machine.permissionDenied` | Caller is not authorized for the machine the request names: the caller's verified principal does not own the machine the request's `machineId` names (`machines.user_id`). Another user's machine and an unknown machine collapse into this one refusal, so it never says whether the machine exists (this namespace's header). Domain authz code; deliberately never the router's 404, which on this namespace means only that the control plane has no such route. | `permissionDenied` | 403 |
| `machine.folder.topLevel.notOffered` | `machine.folder.list {top: true}` on macOS or Linux, which have no top level: only a Windows computer lists drives and distributions above its folders | `invalidArgument` | 422 |

### Terminal

Terminal refusals: the write lease ([Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior)) and the PTY in the daemon ([ADR-018](../../decisions/018-windows-v1-tier-and-pty-in-the-daemon.md)). The lease is **one per shell**: a session opens as many shells as the machine can hold, exactly one writer holds a given shell at a time, and a device's first write to a shell nobody holds takes it; every other write from a writer the shell's hold is not bound to is refused. Every lease refusal below is about one shell, named by the terminal identifier the request carried, and a lease held on one shell never authorizes a write to another. A request naming a shell its session does not have is refused `terminal.notFound`, the flow-control signal excepted, and a take or a write naming an output subscription that is not the calling connection's own open subscription to that shell is refused `terminal.output.subscriptionNotFound` before the lease is read, so a hold is never bound to another connection's pane.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `terminal.control.notHeld` | A write from a connection the shell's hold is not bound to — a shell another writer holds, or one its own device holds through other connections until this one takes it — a run's write to a shell it does not hold, or a resize or a pane's appearance report for a shell nobody holds or that its own device holds through other connections; a device's first write to a shell nobody holds takes it instead of being refused. `data.fields`: `terminalId` | `failedPrecondition` | 409 |
| `terminal.control.heldByOther` | `terminal.control.take`, a resize, a pane's appearance report or a close refused for the named shell because someone else holds it. **Two take refusals share this code; the second has the stronger precondition.** A plain take while another of the account's devices holds that shell: refused, and the recourse is the take's forced form, which moves the lease to the taker without a release. Any take while a run's command holds the shell: refused, and normatively so, because a run's hold ends with its command or the run and never by a lease contest — the recourse is stopping the command from its row, or pausing or interrupting the run, and the hold then ends when the command ends or on the run's first transition out of running, whichever comes first. `data.fields` names the shell and its holder flat, as `terminal.control.changed` does — `{ terminalId, holderDeviceId, holderRunId?, holderCommandId? }`, with `holderRunId` and `holderCommandId` set together while an agent's running command holds the shell and the agent read from that run — on the JSON-RPC surface, and beside `code` and `message` on the HTTP `ErrorResponse` body (the same value on both surfaces) | `failedPrecondition` | 409 |
| `terminal.notFound` | A request naming a shell its session does not have: no shell by that terminal id, or another session's shell, which the refusal never tells apart. The flow-control signal is the one exception: naming such a shell changes nothing, since it may race a closing shell. `data.fields`: `terminalId` | `notFound` | 404 |
| `terminal.output.subscriptionNotFound` | `terminal.control.take` or `terminal.write` naming an output subscription that is not the calling connection's own open `terminal.output.subscribe` subscription to the named shell: no such subscription, another connection's, or one to another shell, which the refusal never tells apart. Checked before the lease is read, so a hold is never bound to another connection's pane. `data.fields`: `terminalId`, `outputSubscriptionId` | `notFound` | 404 |
| `terminal.chatUnsupported` | `terminal.open` on a chat session, which is bound to a managed workspace and no repository and has no shell. No shell starts; the same request succeeds once the chat becomes a project in place, under the same session id. `data.fields`: `sessionId` | `failedPrecondition` | 409 |
| `terminal.write.limitReached` | A `terminal.write` that found 16 of its connection's writes to that shell waiting for an answer. A client keeps at most 8 waiting and sends an interrupt, quit or suspend key past them only while fewer than 16 wait, so only a client fault reaches it; nothing is written and the write is never retried, since a resent write could land after a later keystroke. `data.fields`: `terminalId`, `limit` | `resourceExhausted` | — |
| `terminal.backendUnavailable` | The PTY a shell needs cannot be opened: `sidekicks-terminal` in the daemon could not create it (ConPTY on Windows, `alacritty_terminal`'s tty elsewhere). Each platform has one PTY and no fallback. `data.fields`: an optional `cause` | `unavailable` | 503 |

Opening a shell on a session that is a chat is refused `terminal.chatUnsupported`: a chat is bound to a managed workspace and no repository, so it has no shells.

### Workspace

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `workspace.notFound` | Workspace does not exist | `notFound` | 404 |
| `workspace.preparationFailed` | Preparing the workspace failed due to an internal error | `internal` | 500 |
| `workspace.modeUnsupported` | A worktree was requested for a chat's managed workspace, which offers only its own root (Plan-006 D-006-5) | `invalidArgument` | 422 |
| `workspace.rootUnavailable` | Workspace execution root is unavailable; new write runs are blocked until repair ([Spec-007 §Fallback Behavior](../../specs/007-repo-attachment-and-workspace-binding.md#fallback-behavior); thrown by the Plan-006 `assertWritable` write gate, CP-006-3) | `failedPrecondition` | 409 |
| `workspace.executionRoot.unresolved` | A repo-bound run reached the setup gate with no resolved execution root for the workspace's selected mode and root preparation failed; the run ends `failed` with this error as its cause ([Spec-008 §Fallback Behavior](../../specs/008-worktree-lifecycle-and-execution-modes.md#fallback-behavior); Plan-007 D-007-16) | `failedPrecondition` | 409 |
| `workspace.branchNameRequired` | A wire-initiated (pre-run) `workspace.executionRoot.prepare` for a `provisionedWorktree` omitted `branchName`: the Spec-008 slug rule's derivation inputs (queue-item summary / run id) exist only on the run-setup gate path, so wire prepares must carry the branch. A `boundRoot` prepare names no branch: the daemon follows whatever branch the checkout is on (Plan-007 D-007-18) | `invalidArgument` | 400 |

### Project

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `project.notFound` | A project id that names no project this machine holds; nothing is written | `notFound` | 404 |
| `project.clone.refused` | `project.clone.start` refused before anything is fetched. `data.fields.reason: destinationNotEmpty` when the destination exists and is not empty, drawn `<folder> is already there and is not empty.`; `data.fields.reason: noDirectoryName` when git can name no folder from the address (`host:`, `team/..`), with `data.fields.line` carrying git's own line, `fatal: No directory name could be guessed.`, which the clone card shows as it shows any clone's failure, the `Repository URL` field keeping the address to fix ([Spec-007 §Required Behavior](../../specs/007-repo-attachment-and-workspace-binding.md#required-behavior)) | `invalidArgument` | 422 |
| `project.clone.unavailable` | `project.clone.start`, `project.clone.folder.read`, `project.clone.subscribe`, `project.clone.answer`, `project.clone.cancel` and `project.largeFile.pull` answered while the clone service is not running. When its start failed — the askpass program git asks its sign-in questions through could not make its folder or socket, or the recovery of clones a restart cut short failed — the message is that failure's own text, such as `listen EACCES: permission denied`, its paths redacted as every message's are. When the service was never started, on a platform with no askpass link (Windows, whose link is the `windows` unit's), the message is empty. No `data.fields`; the service log holds the start's failure or the reason it was never started | `unavailable` | 503 |
| `project.environment.nameRefused` | An environment row's name refused at save, from `machine.settings.update` or `project.environment.update`; nothing is written and the rows stay as they were. `data.fields`: `name`, the refused name, so the page marks the row it was typed into, and `reason`, one of `notAName`, `credentialShaped` or `setByApp` | `invalidArgument` | 422 |
| `project.branchPattern.refused` | A branch-name pattern refused at save, from `machine.settings.update` (`Every project`'s `Branch names`) or `project.branchPattern.update`, one rule for both; nothing is written. `data.fields` is `ProjectBranchPatternRefusedDetails`, whose `reason` is `titleNotOnce` (`Put {title} in the name once.`), `notABranchName` (`Git does not accept this as a branch name.`) or `clashesWithBranch`, whose `projectId` names the project whose repository holds the branch and whose `gitMessage` carries git's own line for a name that clashes with an existing branch — one that would hold it or sit inside it, such as `'refs/heads/feature' exists; cannot create 'refs/heads/feature/fix-login'`, or one of the same name, `reference already exists` — with git's `fatal: prepare: ` prefix removed, and after it the `cannot lock ref '<name>': ` clause a repository on git's files backend writes (one on the reftable backend writes none), the rest as git wrote it; the whole name is checked by `git check-ref-format --branch` and against existing branches through a ref transaction git prepares and the check aborts (`git update-ref --stdin`), whose short-lived lock file git removes, so nothing is kept; a repository with no commit has no branch to clash with, so that check is skipped there; the pattern schema's own issue message is that reason code, and the screen holds the first two reasons' words | `invalidArgument` | 422 |

A clone that fails once git has started is a failure of the clone, not a refusal of a call, and carries no code: the clone card shows git's own last error line, which `project.clone.subscribe` carries as the clone's failure line ([Spec-007 §Required Behavior](../../specs/007-repo-attachment-and-workspace-binding.md#required-behavior)).

### Repo Mount

Repo-mount attach/detach/resolution errors (Plan-006 D-006-3). The `repoMount` namespace binds to the mount lifecycle; `workspace.*` binds to the bound-workspace lifecycle. `repoMount.rootResolutionFailed` messages MUST NOT echo the attempted path (error-sanitization discipline; the daemon substrate's `sanitizeFields` is the second layer).

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `repoMount.notFound` | Repo mount does not exist, or is no longer attached for a bind or a project `session.create` to name; the create writes nothing | `notFound` | 404 |
| `repoMount.rootResolutionFailed` | Canonical repository root could not be resolved for the supplied path; attach fails explicitly rather than guessing ([Spec-007 §Fallback Behavior](../../specs/007-repo-attachment-and-workspace-binding.md#fallback-behavior)). `data.fields.reason: notARepository` when the folder is not in a git repository, drawn `Could not attach: not a git repository`. `machine.folder.list` refuses the same way for a folder it cannot list, `reason` `pathNotFound`, `notReadable` or `notAbsolute`, with `data.fields.detail`, the system's own reason for the failed read (never a path), which the list shows in place | `invalidArgument` | 422 |
| `repoMount.outsideTrustEnvelope` | A picked folder lies outside the project's admitted roots — the repository's own checkout and the worktrees git lists for it — and is refused, writing nothing. `data.fields.reason: worktreeRemoved` when a move names a tree whose removal is committed while its folder waits for deletion, drawn `Could not move: <worktree> was removed`; `data.fields.reason: outsideProject` for every other folder, a bind's included, drawn `Could not move: <path> is not a worktree of this project`. It carries no path, and its message never echoes the attempted path (the sanitization rule above) | `invalidArgument` | 422 |
| `repoMount.alreadyAttached` | The resolved canonical root is already attached on this machine: a mount belongs to the machine, one per canonical root in each place (Plan-006 D-006-7). `data.fields.conflictingRepoMountId` names the mount that holds the repository and `data.fields.conflictingProjectId` its project, null when the holder is a chat's own workspace, which has no project; no path is named. `repoMount.attach` of a folder whose repository is a chat's own workspace is drawn `Could not attach: <folder> is already attached to a chat`. `repoMount.reattach` is refused with it when the repository the folder now holds is another attached project's, drawn `Could not re-attach: <folder> is already attached to <project>`, `<project>` being the name the project list gives `conflictingProjectId`; with a null `conflictingProjectId` the line reads `a chat` in place of the project, `Could not re-attach: <folder> is already attached to a chat` | `alreadyExists` | 409 |
| `repoMount.reattachRefused` | `repoMount.reattach` refused, writing nothing. `data.fields.reason: identityMatches` when the mount does not read `identityMismatch` at the call; a folder that is no longer a git repository is refused `repoMount.rootResolutionFailed` with reason `notARepository` instead ([Spec-007 §Repo Mount Health (V1 Definition)](../../specs/007-repo-attachment-and-workspace-binding.md#repo-mount-health-v1-definition)) | `failedPrecondition` | 409 |
| `repoMount.reattachConflict` | `repoMount.reattach` refused, writing nothing, while an agent runs anywhere in the project. `data.fields.runningSessionId` and `data.fields.runningAgentId` name the run's session and agent, drawn `Could not re-attach while <agent> is running. Stop the run first.` ([Spec-007 §Repo Mount Health (V1 Definition)](../../specs/007-repo-attachment-and-workspace-binding.md#repo-mount-health-v1-definition)) | `failedPrecondition` | 409 |
| `repoMount.detachConflict` | Detach refused while an agent runs anywhere in the project, naming the running session (drawn `Busy: <session> is running in it.`); active work must finish or be canceled first, and there is no force-detach ([Spec-007 §Detach Semantics (V1 Definition)](../../specs/007-repo-attachment-and-workspace-binding.md#detach-semantics-v1-definition)) | `failedPrecondition` | 409 |
| `repoMount.managed` | The mount is a chat's managed workspace, which only that chat binds and only its purge removes: another session's bind, any detach and a `session.workingFolder.update` of the chat are refused, writing nothing (`data.fields`: `repoMountId`) | `failedPrecondition` | 409 |
| `repoMount.distributionNeedsWsl2` | `repoMount.attach`, `machine.folder.list` or `project.clone.start` refused because the folder is inside a WSL 1 distribution, writing nothing; `data.fields` is `DistributionRefusalDetails`, whose `distro` names it as the request gave it, drawn in place `Ubuntu-18.04 runs on WSL 1. Convert it to WSL 2 or pick another folder.` with `wsl --set-version Ubuntu-18.04 2` under it as text | `failedPrecondition` | 409 |
| `repoMount.distributionNotFound` | `repoMount.attach`, `machine.folder.list` or `project.clone.start` refused because the path or place names a WSL distribution that is not on this computer, writing nothing; `data.fields` is `DistributionRefusalDetails`, whose `distro` names it as the request gave it, drawn in place `No WSL distribution named Kali is on this computer.` | `invalidArgument` | 422 |

### Worktree

Worktree lifecycle errors (Plan-007 D-007-4). The `worktree` namespace binds to worktree rows. There is deliberately no `worktree.unsupported` code: a worktree that cannot be made surfaces as `worktree.createFailed`, and a worktree requested for a chat's managed workspace is refused with `workspace.modeUnsupported`. Failure messages MUST NOT echo attempted filesystem paths (error-sanitization discipline, same posture as §Repo Mount).

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `worktree.notFound` | Worktree does not exist | `notFound` | 404 |
| `worktree.removed.notFound` | `worktree.restore` or `worktree.removed.delete` named a kept worktree that does not exist, such as one a put-back or deletion queued before it already removed; `data.fields.removedWorktreeId` names it | `notFound` | 404 |
| `worktree.createFailed` | Worktree creation failed (git error, filesystem error, or dynamic worktree unavailability at preparation time); the owning workspace transitions to `rootLost` via `failRootPreparation` and the failure detail rides `workspace.rootLost` metadata. `data.fields.reason: carryCheckoutRunning` when the uncommitted work was not carried because another session's run is live in the checkout it would be carried from; `data.fields.runningSessionId` and `data.fields.runningAgentId` then name the run's session and agent, drawn `Could not bring the changes over while <agent> is running in this checkout. Stop the run first.` | `internal` | 500 |
| `worktree.branchCollision` | Caller-supplied branch name collides with a live checkout on the same mount; user intent is never silently adapted — daemon-derived default names ordinal-suffix instead ([Spec-008 §Branch, Base And Preparation Rules](../../specs/008-worktree-lifecycle-and-execution-modes.md#branch-base-and-preparation-rules) collision policy) | `alreadyExists` | 409 |
| `worktree.retireConflict` | `worktree.retire` with `discard: false` refused. `data.fields.reason` is one of `rootBusy` (an agent is running in the worktree, `data.fields.runningSessionId` naming its session) or `hasChanges` (the tree holds something to lose that the confirm did not show — ignored files count — and the refusal carries the current risks so the confirm redraws them). `discard: true`, sent only after the discard confirm, is never refused for `hasChanges` | `failedPrecondition` | 409 |
| `worktree.retireFolderHeld` | `worktree.retire` with `discard: true` refused because the operating system refused the move-aside rename while a program outside the app holds a file in the worktree open; nothing is removed, and the screen reads `A program outside the app is using a file in this worktree.` | `failedPrecondition` | 409 |
| `worktree.retireIncomplete` | `worktree.retire` with `discard: true` refused because the move across volumes copied the tree whole to its kept place but could not remove the original completely; the kept copy is listed and the tree stays live. `data.fields.worktreeId` and `data.fields.removedWorktreeId` name the tree and its kept copy, and no path is named: the screen finds both folders from the worktree list and the removed list and reads `Kept a copy, but some files are still in <worktree folder>. Close what is using them, then remove it again.` | `failedPrecondition` | 409 |

### Artifact

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `artifact.notFound` | Artifact does not exist | `notFound` | 404 |
| `artifact.tooLarge` | `data.fields.reason` names which bound it hit. `declaredSizeExceeded`: an ingest stream passed its own start-declared total, enforced as its spool reservation and per-stream ceiling per the stream protocol's reservation rule; a chunk pushing the running decoded count past the declaration is this refusal with the spool deleted, naming the file and `declaredSizeBytes`. `volumeTooSmall`: a start, or a client's `artifact.publish`, declared more than the spool's volume can hold even with no other upload open, read from the disk at admission, which waiting can never admit; it names the file, when there is one, and `availableBytes`, the room the disk has | `resourceExhausted` | 413 |
| `artifact.filePublishRefused` | A client's `artifact.publish` declared `artifactType: "file"`. A file's bytes reach the store only through the ingest calls, the one hardened way in for them, so the publish is refused and the file is sent with `artifact.ingest.start`; nothing is written | `invalidArgument` | 422 |
| `artifact.idempotencyConflict` | An `artifact.publish` or `artifact.ingest.start` reused a `clientIdempotencyKey` with a differing request: a publish in the same session whose run, type or payload digest differs from the first one's, or a start in the same session whose run, file name or declared size differs from the first one's while its stream lives. What the key first answered is untouched and the conflicting request is refused (an identical resend is not an error: it answers the first publish's manifest or the first start's `ingestId`), as §Agent Intervention `agent.intervention.idempotencyConflict` does. `data.fields`: `artifactId` (the publish's first manifest) or `ingestId` (the first start's stream) | `invalidArgument` | 422 |
| `artifact.ingest.capacityExhausted` | `artifact.ingest.start`, or a client's `artifact.publish` once its frame is read, refused because the open-upload count (ingest streams and client publishes in flight together) has reached `max_active_ingest_streams` or the spool's volume, read at admission, has no room for this declaration beside the open uploads' reservations — transient backpressure, retry later, **no stream state created** — no `ingestId` is minted, nothing is counted against `max_active_ingest_streams`, and no reservation held, so releasing one open stream admits the next start; because the refusal issues no id, the zero-state property is observable through that next admission rather than through any identifier the caller could probe (admission is a serialized reserve-then-install section, so two concurrent starts cannot both pass the bound). Deliberately distinct from the terminal `artifact.ingest.streamInvalid`: this one asks the caller to wait, that one to restart, per the stream protocol in [Spec-012 §Ingest Validation And Payload Bounds (V1)](../../specs/012-artifacts-files-and-attachments.md#ingest-validation-and-payload-bounds-v1) | `resourceExhausted` | 429 |
| `artifact.ingest.streamInvalid` | An ingest stream call that cannot proceed and cannot be retried in place, with `data.fields.reason` naming why: `sequenceBroken` (a sequence gap, regression, or same-sequence different-bytes chunk, which terminates the live stream and deletes its spool), `lifetimeExpired` (a call on a stream past `max_ingest_stream_lifetime`), `unknownStream` (an `ingestId` the daemon does not hold, a terminated stream's among them), `alreadyCompleted` (an `artifact.ingest.write` on a completed stream) or `completionRecordMismatch` (a retried `artifact.ingest.complete` whose saved result no longer carries the digest it was committed under, which ends the stream rather than answer it). The remedy is restart from `artifact.ingest.start`. **Two retries are deliberately NOT this code**, because a lost response must never cost the caller its upload: an **exact retry of the last acknowledged chunk** — same sequence, same bytes — is acknowledged idempotently without re-appending; and a **retried `artifact.ingest.complete` on a completed stream whose completion record is still held** returns the saved result, that record's original response verbatim, re-running no pipeline step and minting no second manifest row (the carved exception; the record is held in memory for the stream registry entry's lifetime, and at most 64 records are held, the oldest let go first, so past `max_ingest_stream_lifetime` or that bound the same retry does receive this code) | `aborted` | 409 |

### Workflow

Every refusal point of the workflow surface carries its own code, registered in its contract before the capability is implemented, and none ships unregistered ([Spec-015 §Loud-errors discipline (C-12)](../../specs/015-workflow-authoring-and-execution.md#loud-errors-discipline-c-12)). A state refusal is 409, well-formed input the daemon cannot act on is 422, and findings ride the error as an extension list. A refusal that names nodes is drawn on those nodes and leaves the draft editable.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `workflow.definition.notFound` | A workflow definition that does not exist | `notFound` | 404 |
| `workflow.version.notFound` | A workflow version that does not exist, by number or by id, a Duplicate's `copiedVersionId` on `workflow.definition.create` among them | `notFound` | 404 |
| `workflow.run.notFound` | A workflow run that does not exist | `notFound` | 404 |
| `workflow.step.notFound` | A step key the run does not hold | `notFound` | 404 |
| `workflow.invalidTransition` | A run or step move its status does not allow: retrying from a step that did not fail, posting the results of an unfinished run, or opening a fix session on a step that did not fail | `failedPrecondition` | 409 |
| `workflow.run.startDenied` | Workflow run start refused by Cedar under `Action::"workflow::start"`, or whose principal could not be resolved: an agent's start, or a run a trigger fires, judged when it fires with the person recorded as its starter | `permissionDenied` | 403 |
| `workflow.definition.refused` | A saved or imported document the daemon's own re-check refuses. `data.fields.findings` is the whole list, `[{rule, nodeIds, detail?}]`, `detail` present exactly on `codePackagesUnresolved`, where it names the package; `rule` is one of the values — `cycle`, `orphan`, `emptyDocument`, `nodeMissing` (an edge naming a node the document does not hold, marking the end it holds), `triggerMissing`, `triggerDuplicate`, `edgeIntoTrigger`, `edgeOutOfTerminal`, `paramMissing`, `expressionUnparsable`, `expressionUnknownNode`, `expressionRegexUnsupported`, `toolEdgeWithoutToolInput`, `handleTypeUnknown` (an edge end whose id does not read as `<mode>/<type>/<index>`, names a type other than `main` or `tool`, stands on the wrong side of its node, or, where its node's kind is in the catalog, names a handle that kind does not declare), `handleTypeMismatch` (a `main` end joined to a `tool` end), `inputConnectionsExceeded` (more edges into an input than it takes), `nameTaken` (a name another workflow in the library holds, in any letter case), `repositoryRequired` (a Git, Read a repo diff or Run tests step under a trigger whose `Repository` is `None`), `unknownKey`, `secretOutsideSensitiveField` and `codePackagesUnresolved` (two imports in one Code step naming one package at different versions). A Code step whose packages cannot be locked is not a finding: the save is kept, the node reads `Packages not locked` with the tool's own words, and a start of that version is refused with `workflow.code.packagesNotLocked` until a later save locks it. A node id used twice is refused when the document is read, before this check: the read's `request.paramsInvalid` issue at that id carries the finding `{rule: "nodeIdDuplicate", nodeIds: [id]}` as its `params` | `invalidArgument` | 422 |
| `workflow.humanForm.revisionStale` | A form draft save or a form submit carrying a revision that is no longer current | `aborted` | 409 |
| `workflow.version.stale` | A save against a stale definition version | `aborted` | 409 |
| `workflow.version.diffCrossWorkflow` | A `workflow.version.diff.read` naming two versions of different workflows; nothing is compared (`data.fields`: `fromWorkflowVersionId`, `toWorkflowVersionId`) | `invalidArgument` | 422 |
| `workflow.cursorUnresolvable` | A `workflow.run.list`, `workflow.step.read` or `workflow.definition.list` `cursor` the daemon did not write, or one past the end of what it pages; nothing is read | `invalidArgument` | 400 |
| `workflow.step.notWaiting` | A form submitted, an approval answered or a form read on a step that is no longer waiting | `failedPrecondition` | 409 |
| `workflow.run.stillRunning` | `Retry from this step` refused while the source run is still going. `data.fields.reason` is `sourceRunning` | `failedPrecondition` | 409 |
| `workflow.run.idempotencyConflict` | A `workflow.run.start`, `workflow.run.retry` or `workflow.run.rerun` reused a `clientIdempotencyKey` with a differing payload; the run the key first answered is untouched and the conflicting request is refused (an identical resend is not an error: it answers that run), as §Agent Intervention `agent.intervention.idempotencyConflict` does. `data.fields`: `workflowRunId` (the run the first request made) and, for a retry or rerun, `sourceWorkflowRunId` | `invalidArgument` | 422 |
| `workflow.run.projectOnProjectSession` | A `workflow.run.start` from a project session that names a project: that session's run works in the session's own repository, so nothing runs | `invalidArgument` | 422 |
| `workflow.run.repositoryRequired` | A start, or a node run (`workflow.node.execute`), that names no project's repository — a `None` run, or a start in a chat that names none — of a workflow version holding a Git, Read a repo diff or Run tests step; `data.fields.nodeIds` names those nodes. Nothing runs | `invalidArgument` | 422 |
| `workflow.run.inputRequired` | A start that leaves a required input its workflow declares unfilled, or gives an input a value that does not fit it; `data.fields.inputNames` names those inputs. Nothing runs | `invalidArgument` | 422 |
| `workflow.code.packagesNotLocked` | A start of a workflow version whose Code steps' packages are not locked; `data.fields.nodeIds` names those nodes. A later save that locks them makes the version runnable | `failedPrecondition` | 409 |
| `workflow.run.notDeletable` | `Delete run` on a run that is `new`, `running` or `waiting` or is a failed run parked on its failed step, or on a chain's first run while a later run of its chain is one of those, drawn `Cancel it first.`; nothing is deleted | `failedPrecondition` | 409 |
| `workflow.trigger.unarmable` | A trigger that cannot be armed in the state it meets; the same request succeeds once that state is fixed | `failedPrecondition` | 409 |
| `workflow.webhookToken.mismatch` | A webhook call with a wrong or missing token, any call while no token exists, or a call to a hook id that does not exist: one answer, with `WWW-Authenticate: Bearer`, so the listener never says which ids exist | `unauthenticated` | 401 |
| `workflow.definition.importSchemaUnknown` | An import whose schema version is unknown | `invalidArgument` | 422 |
| `workflow.secret.nameInvalid` | A secret name refused at save because it breaks the pattern | `invalidArgument` | 422 |
| `workflow.secret.nameTaken` | A secret name refused at save because another secret already holds it | `alreadyExists` | 409 |
| `workflow.run.repairNotParked` | Frozen-definition re-pin refused: the target run is not parked — a running instance is never re-pinned, unconditionally, per [Spec-015 §Frozen-definition repair (SA-38)](../../specs/015-workflow-authoring-and-execution.md#frozen-definition-repair-sa-38); the refusal is total, leaving the run unchanged on its original pinned version (registers with Plan-014 T5.21) | `failedPrecondition` | 409 |
| `workflow.run.repairAttemptInFlight` | Frozen-definition re-pin refused: a step of the run is still in flight — the park's resume continues that step rather than starting it fresh (a usage-limit park by construction, which starts no new step), or a parked parallel branch holds a step that will continue later — so the refusal names the blocking step and the explicit fresh-start action that would discard it, instead of swapping the run-level definition pointer under steps already dispatched from the frozen bytes ([Spec-015 §Frozen-definition repair (SA-38)](../../specs/015-workflow-authoring-and-execution.md#frozen-definition-repair-sa-38), the run-wide fresh-start rule; refusal is total; registers with Plan-014 T5.21) | `failedPrecondition` | 409 |
| `workflow.run.repairVersionUnaccountable` | Frozen-definition re-pin refused: the target version cannot account for the nodes the run has already completed — it omits a node whose outputs the run holds, or its graph would leave a completed node unreachable, which [Spec-015 §Frozen-definition repair (SA-38)](../../specs/015-workflow-authoring-and-execution.md#frozen-definition-repair-sa-38) states is one failure rather than two; refusal is total, leaving the run parked on its original version with its schedule state untouched (registers with Plan-014 T5.21) | `failedPrecondition` | 409 |
| `workflow.run.notCancelable` | `workflow.run.cancel` refused because the run has ended, so there is nothing to cancel and reporting success would misinform the person about what their action did. Deliberately **not** the answer for a run already `canceled`: that call returns the saved result, the original `workflow.run.canceled` event with `alreadyCanceled: true`, minting no second status write and no second event, because a retried cancel must never cost the person a clear answer. Cancel is available on every `new`, `running` or `waiting` run and on a `failed` run parked on its failed step, which reads `failed` while it waits on Resume and has not ended; a parked run is cancelable **without precondition** ([Spec-015 §Park integrity and cancelability (SA-39)](../../specs/015-workflow-authoring-and-execution.md#park-integrity-and-cancelability-sa-39)) (registers with Plan-014 T5.22) | `failedPrecondition` | 409 |
| `workflow.run.resumeNotParked` | `workflow.run.resume` refused because the target run is not parked — there is no suspension to lift, so a resume would either be a no-op dressed as an action or a second dispatch of a running step. Distinct from `workflow.run.repairNotParked`, which refuses the **re-pin leg** of a resume under [Spec-015 §Frozen-definition repair (SA-38)](../../specs/015-workflow-authoring-and-execution.md#frozen-definition-repair-sa-38): that code names a repair the run's state forbids, this one names a resume the run's state forbids, and collapsing them would leave the person unable to tell whether dropping the re-pin would have worked. Refusal is total; the run is unchanged. Resuming a parked run **ahead of** an armed `resumeAt` is not a refusal at all — the schedule is advisory pacing, the resume proceeds, and a still-spent provider account simply re-parks with its own `workflow.phase.suspended` (registers with Plan-014 T5.22) | `failedPrecondition` | 409 |

**Step failures.** These codes fail a step rather than refuse a call: each rides the step's `error` on its row and the `workflow.step.failed` event, for the life of the run record, and the run then takes the step's own error disposition. Their status column is notional.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `workflow.code.overBudget` | A Code step over its memory budget, 256 MiB per node by default and settable | `resourceExhausted` | 422 |
| `workflow.code.installFailed` | A full-tier Code step whose package install did not finish. `data.fields`: `reason` (`diskSpace` \| `toolError`) and `detail`, `bun`'s or `uv`'s own error | `internal` | 500 |
| `workflow.step.threadFailed` | A quick step whose thread or engine could not be made; the step fails at once, with no start timer. `data.fields.reason`: `startFailed` | `internal` | 500 |
| `workflow.sandboxUnavailable` | A full-tier Code step, or a shell step at the Sandboxed level, whose provider sandbox did not start — `@anthropic-ai/sandbox-runtime` for Claude Code, `codex sandbox` for Codex. `data.fields`: `provider`, the step's provider id, and `detail`, the wrapper's own error. The step never falls back to running unprotected, and no other level is substituted for the one the run holds | `unavailable` | 503 |
| `workflow.step.timedOut` | A step or a run cut by a time limit, read `failed · timed out`. `data.fields`: `cause` (`stepTimeout` \| `runCap`) and the limit | `deadlineExceeded` | 504 |
| `workflow.secret.notFound` | A secret reference the keychain does not hold. `data.fields`: `reference` only. It reads `not on this computer` for a shared secret, `not in <project>` for a project secret, and `This run has no repository` for a project secret on a run that works in no project's repository. The step offers `Retry from this step` | `notFound` | 404 |
| `workflow.secret.storeUnavailable` | The keychain is locked or unavailable. `data.fields.cause`: `locked` \| `unavailable`. The step fails with its cause and offers `Retry from this step`; it never waits indefinitely and never falls back to a plaintext value | `unavailable` | 503 |

One code outside `workflow.*` fails a step: a step whose agent cannot be resolved fails with `agent.definition.resolutionRefused`, carrying that refusal's own `reason`; its `data.fields` are that refusal's own (listed under [Agent Definitions](#agent-definitions)), except that `definitionId` is `null` for a step running the General agent. The case [Spec-025 §The account registry](../../specs/025-provider-accounts-and-credential-homes.md#the-account-registry) settles is a step's park on a spent account racing that account's removal: where the removal commits first, the step fails with reason `accountUnavailable`. No other `agent.*` code rides a step's `error`.

No code names a refused cancellation **of a parked run**, because a parked run is cancelable without precondition; cancel and resume check only the run's state. A park itself is a state transition rather than a caller-visible refusal.

### Provider Account

Refusals on the machine's own provider accounts ([Spec-025](../../specs/025-provider-accounts-and-credential-homes.md)). Every one of these is **fail-closed**: the daemon refuses the run rather than falling back to ambient credentials, to a different account, or to an unvalidated home. A silent fallback here would execute against an account the person did not choose and bill spend to a party that never authorized it, so there is deliberately no permissive path.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `provider.account.notRegistered` | No account is registered for the requested provider; a provider run cannot be admitted. The remedy is registration, not a default — there is nothing to default to | `failedPrecondition` | 409 |
| `provider.account.current.notSet` | Accounts exist for the provider but none carries the current mark, so resolution is ambiguous and refuses rather than picking one. A run never names its own account: the account is the one the session is on, moved only by `provider.account.current.update` | `failedPrecondition` | 409 |
| `provider.account.notFound` | The referenced `providerAccountId` is not present in the registry (never registered, or removed after the reference was taken) | `notFound` | 404 |
| `provider.account.credentialHome.unavailable` | The account's credential home is missing, unreadable, or structurally unusable; the run is refused rather than rebound to another account's home (I-023-7). Also the refusal when `provider.account.current.update` names such an account: the current mark does not move, no running session moves, and every session stays on the account it was on ([Spec-025 §Moving a session to another account](../../specs/025-provider-accounts-and-credential-homes.md#moving-a-session-to-another-account)) | `unavailable` | 503 |
| `provider.account.notAuthenticated` | The account's sign-in is gone or refused; the same call succeeds once the person signs in again. `provider.account.current.update` meets it on a known-dead target: its stored reading is `reauthRequired`, or its last limits read showed its Claude Code login gone (`rate_limits_available: false` with `subscription_type: null`); the press refuses in place and carries that account's own remedy in `data.fields.remedy`, a `ProviderRemedy` of kind `signIn`, or `pasteToken` on a token or API-key account: the current mark does not move and no session moves. Every other provider call that needs a sign-in (Generate, a voice call, a session restart, an MCP server's sign-in through the provider) meets it when the provider refuses the account's sign-in (Claude Code's `authentication_failed` or `oauth_org_not_allowed`, Codex's `unauthorized`). No run is refused on its account's stored sign-in state; the session starts and a real sign-in failure arrives from the provider | `failedPrecondition` | 409 |
| `provider.account.allowanceExhausted` | The account's plan allowance or credits are spent (Codex's `usageLimitExceeded` or `sessionBudgetExceeded`; Claude Code's `billing_error`, or a `rate_limit` from its spend cap), shared by Generate, a voice call and every provider call that spends from the account. `data.fields` carries the reset time when the provider gives one (`ProviderUsageLimitResetBoundary`) | `resourceExhausted` | 429 |
| `provider.account.permissionDenied` | The caller is neither this machine's own client nor a linked device: a session asked for a registry verb (I-023-1) | `permissionDenied` | 403 |
| `provider.account.current.conflict` | A concurrent `provider.account.current.update` lost the partial-unique-index race; the database refused the second writer rather than leaving two current accounts for one provider (I-023-5) | `aborted` | 409 |
| `provider.account.signInUnsupported` | Brokered sign-in was requested for a provider whose pinned flow emits neither an authorization URL nor a device code, so there is nothing the person could act on. The daemon refuses rather than spawning a flow that cannot be completed; the remedy is the out-of-band sign-in the readiness handoff already discloses ([ADR-026](../../decisions/026-provider-credential-custody-posture.md) D1) | `unimplemented` | 422 |
| `provider.account.signInInFlight` | A brokered sign-in is already in flight for this account. Refused rather than started, because at least one pinned provider holds exactly one active login slot and **silently drops the previous attempt** — a permissive second start would strand the person mid-flow on another device with no signal that their code had stopped working. The remedy is `provider.account.signInAttempt.cancel` on the in-flight attempt | `failedPrecondition` | 409 |
| `provider.account.credentialSealRefused` | The place the daemon keeps its secrets would not take the token, so registration refuses and the token is stored nowhere else. `data.fields.cause` is one of `locked` or `unavailable`, each drawn as the title `Token not saved` over its line: `Unlock the keychain, then try again.` for `locked`, and `Secrets cannot be used right now. See Settings › Runtime.` for `unavailable`, the same on every system. A Mac tells them apart by the keychain's own error (`errSecInteractionNotAllowed` is locked; `errSecNotAvailable` or `errSecNoSuchKeychain` is unavailable); on Linux, where nothing can be unlocked, the daemon's file sealed through systemd's credential service refuses only with `unavailable`, while it cannot be opened or that service does not answer; where the daemon keeps its items in its plain file, readable by this account alone (mode `0600`), on a Mac from the logged-out service's takeover until `sidekicks daemon uninstall` moves them back, including after that service is turned off in Login Items & Extensions, neither cause is raised ([ADR-026](../../decisions/026-provider-credential-custody-posture.md)). The remedy is a host fix | `unavailable` | 503 |
| `provider.account.inUse` | `provider.account.delete` refused because a run bound to the account is live. `data.fields.sessionIds` names those sessions, at least one, so the person can move them first | `failedPrecondition` | 409 |
| `provider.account.tokenNotAccepted` | The registration-time status invocation, run on a pasted token, reported no signed-in mode, so the provider did not accept the token. Nothing is registered, sealed or replaced, a re-supplied account keeps its prior token, and the refusal carries no byte of the token. Drawn under the field it was pasted into as `The provider did not accept that token.`, the field left empty and `Register` and `Cancel` still there to try another | `invalidArgument` | 422 |
| `provider.account.displayLabelTaken` | The name given to an account added from a pasted token or API key repeats one of that provider's other account names, trimmed and compared by full Unicode case folding (`foldName`). `provider.account.register` and the rename on `provider.account.update` both refuse on it, and nothing is registered or renamed. Drawn under the `Name` field as `Another <provider> account already has this name.` | `alreadyExists` | 409 |
| `provider.account.renameRefused` | `provider.account.update` carried `displayLabel` for an account that carries no typed name: only an account added from a pasted token or API key is named by the person, and every other account is named by the identity its provider reports. Nothing is renamed. No screen draws it: the Providers page offers `Rename` only on a pasted-token or API-key account, so only a caller off that page meets it. | `failedPrecondition` | 409 |

### Agent Definitions

Agent-definition and peer-invocation refusals (Plan-024; [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md)). Every code below is a **fail-closed** refusal: the daemon never substitutes a nearest-match model, a neighboring effort level, or a default provider account for one a definition pins, because silently running something other than what the definition names changes both behavior and price ([Spec-026 §Fallback Behavior](../../specs/026-agent-definitions-and-peer-invocation.md#fallback-behavior)). Definition mutation is the machine's own configuration, so these refusals emit no session event.

**The rows below are the definition-management refusals.** Peer invocation mints no code at all: [Spec-026 §Required Behavior](../../specs/026-agent-definitions-and-peer-invocation.md#required-behavior) requires every peer-invocation refusal to be answered on the callback-tool result's own `denied` / `failed` arms, so a call the approval pipeline declines, an unknown target, and a call that fails once it has started each reach the asking model as a tool result rather than as a JSON-RPC error.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `agent.definition.notFound` | No definition with the given `definitionId` exists on this machine — from an `agent.definition.*` mutation, or from a run that named it as the agent to run. **Never from a peer invocation**: an invocation naming an unknown definition answers on the callback-tool result's `failed` arm, per the paragraph above (`data.fields`: `definitionId`) | `notFound` | 404 |
| `agent.definition.nameConflict` | Requested definition name already exists, compared case-insensitively under full Unicode case folding ([Spec-026 §Required Behavior](../../specs/026-agent-definitions-and-peer-invocation.md#required-behavior); `data.fields`: `name`, `existingDefinitionId`) | `alreadyExists` | 409 |
| `agent.definition.unreadable` | The definition registry could not be read: the library's own list read renders this refusal in place of its rows rather than an empty library, and a run that names a saved agent refuses rather than starting one the registry could not describe. A session whose own agent is already running is unaffected, so a storage fault on this table never blocks ordinary session work (`data.fields`: none) | `unavailable` | 503 |
| `agent.definition.resolutionRefused` | The definition exists but cannot currently produce a runnable agent. `data.fields.reason` is one of `modelUnavailable` \| `effortUnsupported` \| `accountUnavailable` \| `allowlistUnrealizable` \| `providerUnsupported`, carrying the naming field its arm needs (`providerName` plus `modelId`, or `effort` plus the supported `effortLevels`, or `providerAccountId`, or the unrealizable `toolNames` plus the driver's `supportedToolNames`, or the provider name the definition's file carries). **The `providerUnsupported` arm** refuses starting a definition whose file names a provider this app doesn't run, until the person picks an installed provider in the editor; the name the file carries is kept, apart from the binding's `ProviderId`. **The `modelUnavailable` arm answers two situations and names which by what it carries**: a model the definition pins that its provider no longer offers, carrying that `providerName` and that `modelId`; and a caller naming a driver the definition neither defaults to nor overrides while supplying no model of its own, carrying the requested `providerName` and a **null** `modelId`, which reads as "this definition binds no model for that driver". The arm is widened to say the second rather than a second code being minted, because the unresolvable thing is still the model, and the daemon never guesses one ([Spec-026 §Fallback Behavior](../../specs/026-agent-definitions-and-peer-invocation.md#fallback-behavior)). The fourth arm is not optional: [Spec-026 §Required Behavior](../../specs/026-agent-definitions-and-peer-invocation.md#required-behavior) requires the allowlist to be **enforced at spawn** rather than merely recorded, so an allowlist the resolved driver cannot realize must refuse here — an allowlist that is stored and not applied reports a restriction that does not hold. One code rather than five because the caller's situation and remedy are identical in every arm (edit the definition, or repair the account), while `reason` carries what to tell the person. **There is deliberately no account-_readiness_ arm**: `accountUnavailable` fires on registry membership, a definite fact the resolver owns, while authentication state is settled at spawn by I-023-3's live probe and [Spec-025 §Machine provider readiness and the sign-in handoff](../../specs/025-provider-accounts-and-credential-homes.md#machine-provider-readiness-and-the-sign-in-handoff) makes the stored readiness projection advisory only against that gate — so a resolution-time refusal read off the stored projection would refuse a run the spawn gate would have admitted (`data.fields`: `definitionId`, `reason`, plus the arm's naming field(s) — two on `modelUnavailable` (`providerName` plus `modelId`, the latter null where the definition binds no model for that driver), one on `accountUnavailable`, two on `effortUnsupported` (`effort` plus the supported `effortLevels`), two on `allowlistUnrealizable` (the unrealizable `toolNames` plus the driver's `supportedToolNames`) and one on `providerUnsupported` (the provider name the file carries), each pair naming what was asked for beside what is available because neither alone tells the person what to edit) | `failedPrecondition` | 409 |
| `agent.definition.exportWriteFailed` | `agent.definition.export` could not write a definition's file into the chosen folder; `data.fields.cause` carries the operating system's cause | `internal` | 500 |
| `agent.definition.updateRefused` | `agent.definition.update` refused the change. `data.fields.reason` is one of `pluginReadOnly` (the definition is a plugin's agent, which is read-only; its plugin is removed in `Browse plugins`) or `notOrphaned` (a reattach to a picked file named a record that is not orphaned) | `failedPrecondition` | 409 |

### MCP Governance

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `mcp.server.notFound` | No server with the requested `(provider, scope, scopeRef, serverName)` binding exists in the unified inventory — identity is per-provider and per-scope, so a same-named server on another provider or in another scope does not match ([Spec-024 §Unified Inventory](../../specs/024-mcp-server-configuration-and-governance.md#unified-inventory)) | `notFound` | 404 |
| `mcp.server.configInvalid` | The submitted server configuration failed validation — malformed shape, unknown transport, or any refusal detectable **before the durable leg commits**; strictly pre-commit by contract: once the durable write has landed, per-leg live-application failures (including Claude `setMcpServers` per-server errors) report as `liveResults[]` entries on the successful response, never as this error, so a caller is never induced to retry a committed mutation ([Spec-024 §Configuration Mutation](../../specs/024-mcp-server-configuration-and-governance.md#configuration-mutation)) | `invalidArgument` | 400 |
| `mcp.server.configWriteConflict` | A Codex config write lost to a concurrent edit, on either arm: a `user`-scope write's `expected_version` hit `configVersionConflict`, which is returned at once with no retry, and the error carries both version tokens so the caller can re-inspect; or the `project` file no longer hashes to what the daemon last read, so the edit is not renamed into place and the file is left as it was ([Spec-024 §Configuration Mutation](../../specs/024-mcp-server-configuration-and-governance.md#configuration-mutation), [Spec-024 §Fallback Behavior](../../specs/024-mcp-server-configuration-and-governance.md#fallback-behavior)) | `aborted` | 409 |
| `mcp.server.signInFailed` | The daemon failed to **launch** the sign-in for a passing reason — the server or the network unreachable during discovery or registration, or the provider's own flow in its throwaway home failing to start — so the same sign-in can be tried again under a new key; surfaced on the still-open `mcp.server.signIn` call; strictly launch-phase: once the call has returned, an asynchronous completion failure is delivered as the `mcp.server.signIn.completed` event with `outcome: 'failure'` (observable on the `mcp.subscribe` stream), never as a late error on a completed call; the message never carries authorization URLs or credential material ([Spec-024 §OAuth Orchestration](../../specs/024-mcp-server-configuration-and-governance.md#oauth-orchestration)). A provider not installed answers `provider.notInstalled`, the provider's process failing `provider.unavailable`, a provider step too slow `provider.timeout`, and a fault of the daemon's own (its throwaway home not made, a local read or write) `system.internalError` | `unavailable` | 503 |
| `mcp.server.signInUnsupported` | `mcp.server.signIn` named a server that publishes no sign-in route: no protected-resource or authorization-server metadata, or metadata the daemon cannot read | `unimplemented` | 422 |
| `mcp.bindingStoreUnavailable` | The binding store is unreachable: the inventory serves its degraded arm and every MCP mutation fails closed, changing nothing ([Spec-024 §Fallback Behavior](../../specs/024-mcp-server-configuration-and-governance.md#fallback-behavior)) | `unavailable` | 503 |
| `mcp.server.notRunning` | `mcp.resource.list` named a server that is off or not working in the session, so it has no resources to list | `failedPrecondition` | 409 |

### Skill

Skill-library refusals ([Spec-029](../../specs/029-skills.md)).

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `skill.pathRefused` | `skill.update` refused a path in the folder it would save, or `agent.queueItem.create` refused a picked skill whose name and folder match no row of `skill.list`, or, for a Codex agent, no skill Codex's own list names in that folder. `data.fields`: the path, and `reason` — `escapesFolder`, `duplicatePath` or `namesEntryFile` from `skill.update`, `notListed` from `agent.queueItem.create` | `invalidArgument` | 422 |
| `skill.nameTaken` | A save would rename a folder of ours onto a name another folder of ours already holds in the same place; nothing is renamed and nothing is written. `data.fields`: `folderPath`, the folder already holding the name, which the screen names under the Name field, and `place?`, the WSL 2 distribution that folder is in | `alreadyExists` | 409 |
| `skill.nameTooLong` | `skill.create` or `skill.update` would save a name longer than the name limit of a provider the skill is on, that provider's section's `skillNameMaxLength`; nothing is written. `data.fields`: `provider`, the first such provider, and `limit`, its limit in characters | `invalidArgument` | 422 |
| `skill.writeRefused` | A write to a skill was refused. `data.fields.reason` is one of `pluginReadOnly` (every operation that writes refuses a plugin's skill, which is read-only) or `notOrphaned` (`skill.record.reattach` named a record that is not orphaned) | `failedPrecondition` | 409 |

### Git

The review and ship surface's refusals ([Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md)), registered with their verbs in `crates/sidekicks-contracts/src/git/`.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `git.generateFailed` | A Generate, `git.commitMessage.generate` or `git.changeRequest.text.generate`, failed for a passing reason, so the same call can be sent again: the provider was overloaded, rate-limited or failed on its side, its stream dropped or its own retries ran out, the picked model was gone, or it gave no valid structured output. `data.fields.providerFailureDetail` carries the provider's own words, and nothing falls back to another provider, model or account: a chosen provider other than the session's runs on that provider's `Default` account, and a `Default` account that cannot run the request fails with its reason, never swapped. A spent allowance answers `provider.account.allowanceExhausted`, a refused sign-in `provider.account.notAuthenticated`, a provider too slow `provider.timeout`, a provider not installed `provider.notInstalled`, and a request of the daemon's own the provider calls malformed `system.internalError`, Codex's `input_too_large` among them, since every pass is sized under the model's window and Codex's 1,048,576-character limit per message. A diff larger than the model's window is read in passes and is never a failure | `unavailable` | 503 |
| `git.generateRefused` | The provider refused the diff's content by its own policy, so the same diff fails again until it changes. `data.fields`: `reason` (`providerRefused`) and `providerFailureDetail`, the provider's own words | `failedPrecondition` | 409 |
| `git.readFailed` | A read the review pane depends on still failed after the daemon's one retry, so the pane shows its own error state and keeps what it already drew | `internal` | 500 |
| `git.host.invalid` | A host the person tried to add was not added, and nothing is saved. `data.fields.reason` is `notAHostName` (the name does not parse) or `notAnswered` (neither `gh` nor `glab`, installed and signed in, answers for it) | `invalidArgument` | 422 |

### Voice

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `voice.accountNotEntitled` | Voice refused on an account whose sign-in kind its provider gives no voice: on Claude Code, an API-key or cloud-provider account, one that is neither a Claude sign-in nor a pasted Claude token. The account is signed in; its sign-in kind lacks voice. `data.fields`: `reason` (`signInKindNotEntitled`) and `provider`; the screen draws one sentence naming the account, the same on every provider. A provider or build with no voice answers `provider.capability.unsupported` | `permissionDenied` | 403 |
| `voice.call.startFailed` | The session's provider could not start the call `voice.call.start` asked for, for a passing reason: its realtime service or the network failed, or the call closed before its answer, so `Try again` sends it again. A refused sign-in answers `provider.account.notAuthenticated`, a spent allowance `provider.account.allowanceExhausted`, no answer in time `provider.timeout`, an installed Codex without its realtime calls `provider.capability.unsupported`, and Codex refusing the offer the app's window built `system.internalError` | `unavailable` | 503 |

### Cloud

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `cloud.accountNotEntitled` | Sending to the cloud refused because the session's account is signed in a way that lacks its provider's cloud. `data.fields.reason` is `signInKindNotEntitled` (the account's sign-in kind lacks it: a Codex account on an API key rather than a ChatGPT sign-in) or `subscriptionRequired` (the account's plan lacks it: a Claude Code account without a claude.ai Pro, Max or Team sign-in); `data.fields.provider` names the session's provider, so the screen draws that provider's own sentence and remedy. The session menu's list of reasons and this code's reasons come from one declaration | `permissionDenied` | 403 |
| `cloud.githubRemoteRequired` | Sending to the cloud refused because the project has no GitHub remote; the same request succeeds once it has one. No `data.fields` | `failedPrecondition` | 409 |

### Preview

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `preview.addressRefused` | An address Preview will not open; the page stays where it was, and nothing is ever searched on the web. `data.fields.reason` is `scheme` (a scheme the pane cannot open) or `notAnAddress` (the text is not an address at all). The details never echo the address. An address carrying a username or a password opens | `invalidArgument` | 422 |
| `preview.editRefused` | A device's paste, select all or cut for a menu that is no longer the page's current one; nothing changes and the pane reads `The page changed before that could run.` | `aborted` | 409 |
| `preview.filePathRefused` | A device's answer to a folder picker named a file's path that is empty, absolute, holds an empty, `.` or `..` segment, or is missing, or main's download report named a file by anything but an id main minted; nothing is set, dropped or staged. The details never echo the path | `invalidArgument` | 422 |
| `preview.portShare.alreadyExists` | `preview.portShare.add` named a port already on the shared list; nothing changes. `data.fields.port` is the port the request named | `alreadyExists` | 409 |
| `preview.port.notShared` | A forward or a `preview.portTicket.issue` named a port that is not on the shared list. The machine forwards only listed ports, and only to its own loopback. `data.fields.port` is the port the request named | `permissionDenied` | 403 |

### Highlight

Highlight codes ride the daemon JSON-RPC wire with notional HTTP statuses.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `highlight.readReplaced` | A `highlight.read` that a newer read for the same block, on the same connection, replaced while it waited to be colored; only the newer read is answered with the colors. No `data.fields` | `canceled` | 409 |

### Transcript

Transcript codes ride the daemon JSON-RPC wire with notional HTTP statuses.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `transcript.body.offsetInvalid` | A `transcript.body.read` `offset` that is no place to resume from: inside a character or past the body's end. `data.fields`: `offset`, `bodyLength` (the body's length in UTF-8 bytes) | `invalidArgument` | 422 |
| `transcript.row.notFound` | A transcript read named a row the session does not hold: `transcript.body.read`'s row id, so it never reads like a row that carries no body, or `transcript.read`'s `aroundCursor`, at which no row stands. `data.fields`: `rowId` or `aroundCursor` | `notFound` | 404 |

### Provider

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `provider.unavailable` | Provider driver is unavailable for a passing reason, so the same call can be sent again. `agent.run.context.compact` and `provider.command.list` answer it for a run or agent with no live runtime binding, and `agent.command.stop`, `agent.command.background` and `agent.command.write` for a command whose provider cannot be reached. A `session.restart` the provider could not make is refused with it, `data.fields` carrying `providerId`, `recoveryCondition` (`recoveryNeeded`) and `providerFailureDetail`, what the driver read of the failure. A typed command path that holds nothing runnable answers `provider.commandPath.notRunnable` instead. A `provider.model.list` whose provider's catalog reply cannot be read whole (no list, an entry with no id or name, an id listed twice, a page cursor repeated, or more pages or rows than a catalog holds) is refused with it, `data.fields` carrying `providerId` and `providerFailureDetail` naming the row, the cursor or the counts read, never answered with a shorter list. On `approval.denial.override` a press whose request reached the provider with no answer back is held: a second press answers the same refusal and sends nothing until the provider process the request went to has ended. A provider that needs a sign-in answers [`provider.account.notAuthenticated`](#provider-account) instead | `unavailable` | 503 |
| `provider.notFound` | A provider id no registered driver answers to, such as a session made by a provider this build lacks (`data.fields`: `providerId`). `agent.run.pause`, `agent.run.resume`, `agent.run.refusalChoice.resolve` and `agent.run.usageCreditsChoice.resolve` answer it only after the run, its version and its state pass, `agent.run.context.compact` after the session, the run and its live binding, `provider.command.list` for the first of the agent's bindings no driver answers, before any binding is read, and `approval.denial.override` after the session, the block, its earlier override, whether it is overridable and the session's state pass | `notFound` | 404 |
| `provider.capability.unsupported` | The daemon has the method, but this session's provider, account, model or build does not offer it. **Producer:** the `ProviderRegistry` pre-dispatch flag gate, the service's own gate, which no client reads; every driver implements every `ProviderDriver` operation, so a refusal names a capability flag, never a missing operation. A steer is never refused for its files: a message sent while a turn runs is an ordinary send, and its staged `attachments` reach the provider with it. `data.fields` is `{ providerId, flag }` (`flag` a `DriverCapabilityFlag`), with `providerFailureDetail`, the provider's own refusal bounded, where the provider itself refused the call (a Codex build refusing a fork's turn boundary on `rollback`), forwarded unchanged by the IPC layer's driver-error translation. Also registered on `cloud.task.start`, `voice.dictation.start` and `voice.call.start`, which a stale client or the CLI can send for a provider or build without them | `unimplemented` | 422 |
| `provider.timeout` | Provider driver operation timed out. On `agent.run.pause` the run stays `pausing` for the provider's own report; on `agent.run.resume` the run stays as it was and the messages the resume carried are held until the provider's own word or record says whether it took them, so none is sent twice. On `agent.run.refusalChoice.resolve` and `agent.run.usageCreditsChoice.resolve` the run keeps waiting and the answer is held until the provider shows what it did with it, the first answer held kept when a second also gets no answer. On `approval.denial.override` the press is held: a second press answers the same refusal and sends nothing until the provider process the request went to has ended. On `agent.command.stop`, `agent.command.background` and `agent.command.write` the command's row stays as it was until the provider's own ending, and a timed-out write is not sent again until the provider shows whether it took the text, so none is typed twice. On `provider.model.list` and `provider.mode.list` it is one provider's `failure.code`, never the call's refusal | `deadlineExceeded` | 504 |
| `provider.notInstalled` | The provider's command is not installed, so an act that needs it is refused: a setting that needs it turned on (availability for new sessions, the shared terminal service, the terminal plugin), Generate on that provider, and a tool server's sign-in through it | `failedPrecondition` | 409 |
| `provider.commandPath.notRunnable` | Nothing runnable sits at the command path the person typed. `session.restart` refuses with it when the command path the person typed holds nothing runnable. On `provider.model.list` and `provider.mode.list` it is that provider's `failure.code`, never the call's refusal | `invalidArgument` | 422 |
| `provider.row.notFound` | `provider.update` named a row the provider's driver does not declare, writing nothing | `notFound` | 404 |
| `provider.row.valueInvalid` | `provider.update` set a declared row to a value its declaration refuses: another kind, a choice not listed or unavailable, a none the row does not offer, text past its length, or a place on a row that is not set per place (only a switch is); nothing is written | `invalidArgument` | 422 |
| `provider.row.notRunning` | `provider.update` asked to stop a declared action row that is not running in the place named, stopping nothing | `failedPrecondition` | 409 |
| `provider.row.notStoppable` | `provider.update` asked to stop a declared action row whose running progress says it cannot stop (`canStop` false), stopping nothing | `failedPrecondition` | 409 |
| `provider.distributionNotFound` | A per-place provider call, `provider.probe`, `provider.install.start`, `provider.install.subscribe`, `provider.install.stop`, `provider.installUpdate.start`, `provider.installUpdate.subscribe`, `provider.terminalPlugin.update` or a place arm of `provider.update`, named a WSL distribution that is not on this computer, writing nothing; `data.fields` is `DistributionRefusalDetails`, whose `distro` names it as the request gave it | `invalidArgument` | 422 |
| `provider.distributionNeedsWsl2` | The same calls named a WSL distribution that runs on WSL 1, where no session runs, writing nothing; `data.fields` is `DistributionRefusalDetails` | `failedPrecondition` | 409 |
| `provider.noBuildForSystem` | `provider.install.start` or `provider.installUpdate.start` named a place the provider ships no build for, writing nothing | `failedPrecondition` | 409 |
| `provider.place.required` | A per-place provider call with no `place` on a Windows computer where a WSL 2 distribution is; nothing is written | `invalidArgument` | 422 |
| `provider.place.notOffered` | A per-place provider call naming a `place` on macOS or Linux, which offer none; nothing is written | `invalidArgument` | 422 |

A per-place provider call's `place` is judged by its name on every Windows computer: `"windows"` names Windows, and a `{distro}` is refused by its name, `provider.distributionNotFound` or `provider.distributionNeedsWsl2`, whether or not a WSL 2 distribution remains, so a stale `{distro}` reads the same after the computer's last WSL 2 distribution is removed. Where no WSL 2 distribution is, a call with no `place` names the computer's one place; where one is, it is refused `provider.place.required`; on macOS and Linux any `place` is refused `provider.place.notOffered`.

### Daemon

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `daemon.writeRefused` | A mutating call refused by the whole service until the restart's recovery pass has listed the sessions it rebuilds, a call with no top-level `sessionId` until the pass ends, since it can reach any session through a project, a mount, a workspace or a tree, or any call while the local store is unavailable; a session the pass is still rebuilding refuses on its own with `session.rebuilding`, and one whose history is degraded or damaged with `session.history.damaged`. `daemon.stop`, `daemon.restart` and `daemon.flush` are never refused, so the service can always be repaired. `data.fields.recovery`: the machine's state on `daemon.status.read`, `rebuilding` \| `blocked` | `unavailable` | 503 |
| `daemon.repairing` | The answer to a `connection.initialize` the daemon admits (with the start's session token, or on macOS from the desktop's signed client helper) while the service repairs its database file, when it serves only the lifecycle verbs on that connection, so `daemon.stop` or `daemon.restart` ends the repair; a client waits and sends `connection.initialize` again rather than ending the service as one that never answered. `data.fields.progress` is `{ done, total }`, the session events recovered so far of those the damaged file lists, read afresh at each handshake, and is absent while the step the repair is on gives no count. A handshake with any other token, or with none from a caller not admitted by its signature, is refused `auth.token.invalid` | `unavailable` | 503 |
| `daemon.limitExceeded` | A request would pass a daemon limit. `data.fields`: `resource` (the limit's name), `limit` and `current`, all required. The screen says the limit was reached in words and draws no figure | `resourceExhausted` | 429 |
| `daemon.data.storeUnavailable` | `daemon.data.erase` refused before its answer, so nothing was erased: the keychain the erase must empty is locked or cannot be used. `data.fields.cause` is `locked` (drawn `Unlock the keychain, then try again.`) or `unavailable` (drawn `The keychain cannot be used right now. Nothing was erased.`) | `unavailable` | 503 |
| `daemon.data.eraseRunning` | `daemon.data.erase` while an erase runs; nothing new starts, since the running one erases everything | `failedPrecondition` | 409 |
| `daemon.dataExport.alreadyRunning` | `daemon.dataExport.start` while another export runs. `data.fields.jobId` names the running export, whose progress the caller can follow instead | `failedPrecondition` | 409 |
| `daemon.dataExport.destination.alreadyExists` | `daemon.dataExport.start` named a folder that already exists; an export writes only into a new folder | `alreadyExists` | 409 |
| `daemon.dataExport.destination.notWritable` | `daemon.dataExport.start` named a folder that cannot be made: its parent is missing or not writable. `data.fields.path` names the folder | `permissionDenied` | 403 |
| `daemon.dataExport.notFound` | `daemon.dataExport.subscribe` or `daemon.dataExport.cancel` named an export this service does not know: never started, or started before the service last restarted | `notFound` | 404 |

### Attention

Refusals of the delivery channels outside the app, the web address and the email digest ([Spec-017 §Cross-Device Delivery](../../specs/017-notifications-and-attention-model.md#cross-device-delivery)). The address, its signing secret and the mail password are on no reply, event, log or error, so no field here carries one.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `attention.delivery.storeUnavailable` | The keychain holding a channel's secret is locked or unavailable. `data.fields.cause`: `locked` \| `unavailable`, the pair `workflow.secret.storeUnavailable` carries | `unavailable` | 503 |
| `attention.delivery.notConfigured` | `attention.delivery.test` for a channel that is not set up. `data.fields.missing`: `address` \| `password` | `failedPrecondition` | 409 |

### Relay

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `relay.connectionFailed` | A relay connection to the service upstream of it failed, or the background service could not reach the relay with a sign-in's pushed authorization request (`account.signIn`), or got no answer from the control plane to a call it forwards for the desktop app (`controlPlane.call`) within the deadline [Spec-027 §Interfaces And Contracts](../../specs/027-remote-control.md#interfaces-and-contracts) sets. `data.fields.reason`: `unreachable` when no connection was made, `timedOut` when one was made and no answer came in time | `unavailable` | 502 |
| `relay.authenticationFailed` | Relay authentication failed | `unauthenticated` | 401 |
| `relay.spkiMismatch` | The machine refused a pinned relay whose key changed. The pin applies only to a relay whose certificate does not chain to a root the operating system trusts (a self-signed relay, or one on a private certificate authority); a relay with a publicly trusted certificate is checked by the platform's own validation and its host name, so a renewal never trips it. Recorded on the daemon's sentinel session as the `relay.pin.refused {relayHost, pinnedSpkiPrefix, presentedSpkiPrefix}` event, each prefix the first 8 bytes of its key's hash, never a token; the recovery is `sidekicks relay repin --force` with the new hash | `failedPrecondition` | 409 |
| `relay.sourceAddressUnresolvable` | A request reached a sign-in route (sign-in, token refresh or device linking) with no source address the relay can count, so it is refused before anything is counted rather than counted in a bucket other callers share. Registered as `RELAY_SOURCE_ADDRESS_UNRESOLVABLE_CODE` in `crates/sidekicks-contracts/src/rate_limiter.rs` | `invalidArgument` | 400 |
| `relay.rateLimited` | A relay sign-in route refused a request over its rate limit; the body is `RateLimitResponse` (§Rate Limiting) | `resourceExhausted` | 429 |
| `relay.forwardingObject.moved` | On the Workers relay a machine reconnected from another continent, so its channels now pass through a new forwarding object there; the old object closes each device connection still on it with WebSocket close code 4000, in the range RFC 6455 §7.4.2 leaves to applications, and this code as the close reason, and the device negotiates again, which hands it the machine's current forwarding object, and reconnects. It rides no HTTP or JSON-RPC response, so it has no HTTP status | `unavailable` | — |
| `relay.key.inTwoPlaces` | The relay flagged this key as in two places, after two connections under it kept displacing each other three times within a minute, and closed this displaced connection with WebSocket close code 4001 and this code as the close reason. The copy stops reconnecting until the person takes the connection back, with `Connect here` or, on a computer, `sidekicks relay reconnect`, which displaces the other copy in turn. Before the flag a displaced copy reconnects as it always does. It rides no HTTP or JSON-RPC response, so it has no HTTP status | `failedPrecondition` | — |

### Channel

The channel between a device and a machine, on either carrier, the relay or the direct path.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `channel.noCommonProfile` | The machine runs none of the channel profiles a device's first frame offered, on either carrier, so it closes the connection with this code; nothing weaker is offered and there is nothing to fall back to. It rides no HTTP or JSON-RPC response, so it has no HTTP status | `unimplemented` | — |
| `channel.decryptionFailed` | A channel frame failed the Noise transport's decryption — replayed, reordered, altered or forged, which no receiver can tell apart — so the receiving end closes the channel, and the next connection runs a fresh handshake. Counted in the relay block of `sidekicks daemon status`, never drawn. It rides no HTTP or JSON-RPC response, so it has no HTTP status | `aborted` | — |

A device and a machine share one channel, the Noise Protocol Framework's KK pattern in two profiles, `Noise_KK_25519_AESGCM_SHA256` offered first and `Noise_KK_25519_ChaChaPoly_SHA256` second, and a handshake from a key the account's statement chain does not trust simply fails, with nothing to click past: a machine answering under a known id with a new key and no later `machine.added` for that id behind it is refused outright on the device. There is no session group and no per-session device cap: one channel carries every session on the machine, and the relay holds at most one connection per machine key and, for each machine, one per device key (on the Workers relay on that machine's forwarding object, on the Compose relay in its one process).

### Connection

Wire-level codes describing a peer misusing the framing/handshake layer or passing a connection's own bounds. Distinct from §Daemon's `daemon.limitExceeded` (domain-level quota saturation): a connection failure is a peer behaving incorrectly toward the protocol substrate, not a session/run quota refusing additional creates.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `connection.unavailable` | The client cannot reach the daemon's OS-local socket or named pipe, or its link to the daemon is down; no fallback transport exists. A socket failure's `data.fields.reason` is one of the listed reasons in §JSON-RPC Wire Mapping. A call in flight when the link drops: the client resends a call that carries `clientIdempotencyKey` once after it reconnects, before it settles, and settles every unkeyed call with this code | `unavailable` | 503 |
| `connection.message.tooLarge` | An inbound message passed the message cap on its JSON or on its attachments ([Spec-006 §Wire Format](../../specs/006-local-ipc-and-daemon-control.md#wire-format)); the error frame is sent and the connection closes (Plan-005 Phase 2). 413 semantic. | `resourceExhausted` | 413 |
| `connection.subscription.limitReached` | A subscribe call found its connection already holding 10,000 open subscriptions, the backstop against a client that opens them in a loop; it may be sent again once one of them closes. `data.fields`: `limit` | `resourceExhausted` | 429 |
| `connection.call.limitReached` | A call past its connection's `MAX_CALLS_IN_FLIGHT` (100) calls in flight, refused at once; a subscription cancel, a stop or a `terminal.write` takes no slot. A client holds its calls past the cap and sends each as a slot frees, so only a client fault reaches it | `resourceExhausted` | — |

### Request

Codes about one call itself, its envelope, params, method or result, before or after any domain is reached. The control plane's router answers the HTTP ones; on the JSON-RPC wire they take the numbers in §JSON-RPC Wire Mapping.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `request.envelopeInvalid` | The message is not a well-formed JSON-RPC envelope; over HTTP, a body that does not parse or carries no JSON content type, or a body over the route's size limit, which answers 413 with `reason: tooLarge` | `invalidArgument` | 400 |
| `request.protocolVersion.invalid` | Per-request envelope-level `protocolVersion` field violates [Spec-006 §Wire Format](../../specs/006-local-ipc-and-daemon-control.md#wire-format): the field is missing, the wrong JSON type, or fails the ISO 8601 `YYYY-MM-DD` shape. Substrate-side gate; fires BEFORE handler dispatch (I-005-6). Distinct from `connection.version.floorExceeded` / `connection.version.ceilingExceeded` (registry-side handshake-incompatibility) and from `connection.version.mismatch` (registry-side mutating-op gate after handshake declared incompatible). 400 semantic. | `invalidArgument` | 400 |
| `request.paramsInvalid` | The params failed the method's contract check (`data.fields.issues`); params that pass it but name nothing the daemon holds are a domain refusal of the owner's namespace | `invalidArgument` | 422 |
| `request.methodNotFound` | The call names a method the daemon does not register, or a route the control plane does not serve | `unimplemented` | 404 |
| `request.methodNotAllowed` | The control plane's router: a route called with an HTTP method it does not serve | `invalidArgument` | 405 |
| `request.resultInvalid` | The handler's result failed the method's result check, a daemon fault | `internal` | — |
| `request.canceled` | The client canceled the call with `$/cancelRequest` before the daemon reached its commit point | `canceled` | — |

### System

| Code                   | Description                      | Category      | HTTP Status |
| ---------------------- | -------------------------------- | ------------- | ----------- |
| `system.internalError` | Unexpected internal error        | `internal`    | 500         |
| `system.maintenance`   | System is undergoing maintenance | `unavailable` | 503         |

### Session Event

Event-stream cursor errors (Plan-004). Like the `agent.run.*` / `agent.queueItem.*` codes these ride the daemon JSON-RPC wire with the dotted code as the canonical `data.type` identifier; the HTTP status is the control-plane-notional mapping.

| Code | Description | Category | HTTP Status |
| --- | --- | --- | --- |
| `session.event.cursorUnresolvable` | An `EventCursor` submitted to `readAfterCursor` / `readWindow` cannot be decoded to a log position — `decodeEventCursor` rejects a non-integer or a value `< -1` (a UUID an SDK synthesized, a corrupted cursor) under the Plan-004 T4.1 predecessor-position cursor model (typed: `CURSOR_UNRESOLVABLE`) | `invalidArgument` | 400 |

---

## Rate Limiting

Standard 429 response shape (from API Payload Contracts):

```ts
interface RateLimitResponse {
  code: "relay.rateLimited";
  category: "resourceExhausted";
  message: string; // human-readable description
  retryAfter: number; // seconds until retry is allowed
  limit: number; // total allowed requests in the window
  remaining: number; // requests remaining in the current window
  resetAt: string; // ISO 8601 timestamp when the limit resets
}
```

The relay counts requests on its sign-in routes only, and a refusal there returns the `RateLimitResponse` body with HTTP status 429; a counter error fails that one request like any backend error. A request with no source address the relay can count never reaches the counter: it is refused 400 with [`relay.sourceAddressUnresolvable`](#relay), not with this body. The `resetAt` field provides the absolute timestamp (ISO 8601) when the oldest counted request leaves the sliding window, the moment the next request is admitted, complementing the relative `retryAfter` seconds value. Every refusal carries both timing fields, with the `Retry-After` header ([Spec-019 §Overflow Response](../../specs/019-rate-limiting-policy.md#overflow-response)).

Every refusal with this body carries `code: "relay.rateLimited"`. The relay's channel carries no rate limit: its per-connection backpressure slows a sender rather than refusing it.
