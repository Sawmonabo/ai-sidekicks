# Plan-007: Local IPC And Daemon Control

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `007` |
| **Slug** | `local-ipc-and-daemon-control` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-007: Local IPC And Daemon Control](../specs/007-local-ipc-and-daemon-control.md) |
| **Required ADRs** | [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md), [ADR-009](../decisions/009-json-rpc-ipc-wire-format.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | **Tier 1 / Tier 4 split** per [cross-plan-dependencies.md §5 Plan-007 Substrate-vs-Namespace Carve-Out](../architecture/cross-plan-dependencies.md#plan-007-substrate-vs-namespace-carve-out-tier-1--tier-4) — Plan-007-partial (Spec-007 §Wire Format substrate + `session.*` namespace + SDK Zod layer) ships at Tier 1 to unblock [Plan-001](./001-shared-session-core.md) Phase 5; Plan-007-remainder ships at Tier 4. See §Execution Windows (V1 Carve-Out) below. **Tier 1 phase-level imports.** Phase 3 imports [Plan-001](./001-shared-session-core.md) Phase 2 (`packages/contracts/src/session.ts` + `packages/contracts/src/event.ts` Zod schemas) — Plan-007 Phase 3 PR cannot open until Plan-001 Phase 2 has merged. Phase 1 emits `security.default.override` + `security.update.available` events whose taxonomy registration belongs to [Plan-006](./006-session-event-taxonomy-and-audit-log.md) / [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md) (Tier 4) — see §Cross-Plan Obligations CP-007-5 (BLOCKED-ON-C9). |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |
| **Owned Spec-027 Rows** | 2, 3, 4, 7a, 7b, 8, 10 (daemon-side secure-default enforcement — see [Spec-027 §Required Behavior](../specs/027-self-host-secure-defaults.md#required-behavior)) |

## Execution Windows (V1 Carve-Out)

Plan-007 ships in two windows — a **Tier 1 partial-deliverable** (substrate + `session.*` namespace) that unblocks [Plan-001](./001-shared-session-core.md) Phase 5, and a **Tier 4 remainder** that completes the daemon control surface. The split is documented authoritatively in [cross-plan-dependencies.md §5 Plan-007 Substrate-vs-Namespace Carve-Out](../architecture/cross-plan-dependencies.md#plan-007-substrate-vs-namespace-carve-out-tier-1--tier-4); this section is the plan-side restatement so engineers reading Plan-007 in isolation see the split.

### Tier 1 — Plan-007-Partial (substrate + `session.*` namespace)

Lands alongside Plan-001 to unblock Plan-001 Phase 5. Scope:

- **Spec-007 §Wire Format substrate** — `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts` and `packages/runtime-daemon/src/ipc/protocol-negotiation.ts` implementing JSON-RPC 2.0 with LSP-style Content-Length framing (`Content-Length: <byte-count>\r\n\r\n`), 1MB max-message-size, protocol-version negotiation, the typed error model, and supervision hooks. OS-local transport (Unix domain socket / Windows named pipe) is the default; loopback fallback is gated.
- **Spec-027 daemon-side bind-time substrate** — `packages/runtime-daemon/src/bootstrap/secure-defaults.ts` and `packages/runtime-daemon/src/bootstrap/secure-defaults-events.ts` implementing `SecureDefaults.load()` + `effectiveSettings()` + fail-closed enforcement, with validation scope limited to the bind paths Tier 1 exposes (loopback OS-local socket only). Honors §Invariants I-007-1 (load-before-bind), I-007-2 (fail-closed), and I-007-5 (validation surface widens with bind surface) at the Tier 1 bind surface; Plan-007-remainder extends the validation surface at Tier 4 alongside the additional bind paths (HTTP, non-loopback, TLS).
- **`session.*` JSON-RPC method namespace only** — typed handlers for `SessionCreate`, `SessionRead`, `SessionJoin`, `SessionSubscribe` (the Plan-001 vertical-slice contracts). No `run.*`, `repo.*`, `artifact.*`, `settings.*`, or `daemon.*` namespaces in this window.
- **SDK Zod layer (~500–1000 LOC per [Spec-007 §Wire Format](../specs/007-local-ipc-and-daemon-control.md#wire-format))** — the typed wrapper in `packages/client-sdk/` exposing the daemon transport for `sessionClient`. Following the MCP TypeScript SDK pattern.

### Tier 4 — Plan-007-Remainder (other namespaces + supervision + Spec-027)

Lands at Plan-007's original Tier 4 slot, co-tier with Plan-005 (runtime bindings) and Plan-006 (event taxonomy) — all three are gated only on Tier 1 completion per [cross-plan-dependencies.md §5 Canonical Build Order](../architecture/cross-plan-dependencies.md#5-canonical-build-order). Scope:

- The four other JSON-RPC method namespaces — `run.*`, `repo.*`, `artifact.*`, `settings.*`, `daemon.*` — extending the substrate's namespace registry without re-implementing the wire layer.
- The Spec-027 secure-defaults bootstrap surface owned by Plan-007 widens at Tier 4 alongside the additional bind paths — `tls-surface.ts` (row 8 — only load-bearing once a non-loopback / TLS bind enters), `first-run-keys.ts` (row 3 — daemon master key generation; key custody is Plan-022's at Tier 5), `update-notify.ts` (row 7a — periodic poller, not a bind-time gate), and the CLI `self-update` dual-verification command (row 7b — out-of-process). The Tier 1 partial already ships the bind-time `SecureDefaults` validation surface (`secure-defaults.ts` + `secure-defaults-events.ts`) scoped to the loopback OS-local socket bind path it exposes; §Invariants I-007-1 / I-007-2 / I-007-5 hold at every execution window per the validation-surface-widens-with-bind-surface rule.
- The CLI delivery track (`apps/cli/`) and desktop-shell daemon supervision (`apps/desktop/shell/src/daemon-supervision/`, `apps/desktop/renderer/src/daemon-status/`).

### Substrate-vs-Namespace Decomposition Rule (Methodology)

**Rule:** Cross-cutting infrastructure plans MAY be split into a Tier-N substrate-deliverable + a Tier-M namespace-deliverable when (a) the substrate is single-owned and load-bearing for an earlier-tier consumer, AND (b) the namespaces have natural cohesion with their owning plans. Substrate ships first; namespaces ship with their owning plans.

**Rationale.** Spec-007 conflates two concerns — the cross-cutting _transport substrate_ (correctly single-owned by Plan-007: only one set of framing, version-negotiation, and error semantics may exist in the system) and the domain-specific _method namespaces_ (which cohere with their owning plans: `session.*` belongs with session core, `run.*` with run orchestration, etc.). Without a carve-out, Plan-001 Phase 5 either (a) inherits an undeclared forward dependency on Plan-007 at Tier 4, breaking build-order discipline, or (b) duplicates the wire substrate in Plan-001, breaking single-ownership of the transport layer. The carve-out preserves both invariants by isolating the substrate at the consumer's tier while leaving namespace implementations at their natural plan boundaries.

**Applicability.** Apply this pattern when the §3 Inter-Plan Dependency Graph would otherwise need an undeclared forward dependency from an earlier-tier plan to a later-tier infrastructure plan. The pattern is _not_ a license to fragment well-scoped plans for parallelism reasons — both criteria (a) and (b) must hold. **Precedent:** the [Plan-025 / Plan-018 Symmetric Co-Dep Carve-Out](../architecture/cross-plan-dependencies.md#plan-025--plan-018-symmetric-co-dep-carve-out-tier-5) is a sibling pattern (single substrate package extracted from a later-tier plan to satisfy an earlier-tier consumer), though Plan-025 split is by _steps_ rather than by namespace.

**Trade-off accepted.** Plan-007 readers must navigate two windows instead of a single linear sequence; the cross-link from cross-plan-dependencies.md §5 keeps the canonical build order discoverable. This cost is paid once at plan-authoring time; the alternative (silent forward dependency) imposes a recurring cost on every PR-execution agent.

## Goal

Implement the typed local daemon control surface shared by the desktop renderer and CLI, including daemon supervision and protocol negotiation.

## Scope

This plan covers OS-local IPC transport, version negotiation, daemon lifecycle commands, shared client SDK implementation, and the first-class CLI delivery path.

## Non-Goals

- Relay or remote transport
- Provider-driver internal transports
- Browser-only local client support

## Invariants

The following invariants are **load-bearing** and MUST be preserved across all Plan-007 PRs and downstream extensions. They are restated here at top level so that consumers of Plan-007's substrate (Plan-001 Phase 5, Plan-002 `presence.*`, Plan-003 attach calls, Plan-007-remainder namespace handlers) can find them without reading the §Secure Defaults table first.

### I-007-1 — Load-before-bind

`SecureDefaults.load(config)` MUST run **before** any daemon listener binds. Attempting to bind a listener before `SecureDefaults.load` completes is a programmer error and MUST throw.

**Why load-bearing.** This is the invariant whose violation produced the cyclic-dep caught post-hoc by Codex 2026-04-27 (fixed in commit `2d2066b`). Bootstrap-order inversion silently exposes a pre-validation listener to network input. Test must assert load-bearing throw on out-of-order bind attempts.

### I-007-2 — Fail-closed on invalid security settings

`SecureDefaults.load` MUST fail closed on invalid or downgraded security settings — there is no "best-effort partial start" path. At Tier 1, the daemon MUST also refuse settings keys outside the loopback-bind validation scope (e.g., TLS configuration, non-loopback host, first-run-keys policy) with an `unknown_setting` validation error — silent drop is forbidden.

**Why load-bearing.** Best-effort starts mask configuration drift; the override surface is the only sanctioned path for downgrades. Verification: negative-path tests on Tier-4-scope settings keys at Tier 1.

### I-007-3 — `effectiveSettings` exposes only non-secret typed values

`SecureDefaults.effectiveSettings` exposes only non-secret typed values (bind addresses, TLS mode, override flags, fingerprint paths). Raw keys and secrets are NEVER exposed through this view.

**Why load-bearing.** `effectiveSettings` is consumed by every downstream daemon module (gateway, banner, supervision); a secret leaking through this surface is a one-way security regression.

### I-007-4 — Single override-event emission per startup

Every override emits exactly one `security.default.override=<behavior>` log event per startup (not per request, not per event batch).

**Why load-bearing.** Per-request emission would flood the audit log and obscure single-event audit semantics; missing emission would silently hide an active override. Banner content (Spec-027 row 10) enumerates active overrides on every startup as a parallel surface.

### I-007-5 — Validation surface widens with bind surface

These invariants apply to whatever bind paths the daemon exposes at the current execution window. Plan-007-partial (Tier 1) ships a minimal bind surface (loopback OS-local socket only) and a `SecureDefaults` validation surface scoped accordingly; Plan-007-remainder (Tier 4) extends both as additional bind paths (HTTP, non-loopback, TLS) are introduced. The invariants hold at every window — the validation surface widens as the bind surface widens.

**Why load-bearing.** A static validation surface would either over-validate at Tier 1 (refusing Tier-4-scope keys silently) or under-validate at Tier 4 (allowing settings outside the bind paths). Per-window scoping is the only way to keep the invariants honest.

### I-007-6 — Namespace registry rejects duplicate method-name registration

The method-namespace registry MUST reject any second `register(method, ...)` call with an already-registered method name at registration time (not at dispatch time). The error is a programmer error and surfaces synchronously during daemon bootstrap.

**Why load-bearing.** A registry that silently accepts duplicates exposes a non-deterministic dispatch surface — the second handler may shadow the first, the first may shadow the second, or both may run. Every consumer of the registry (Phase 3 `session.*`, Plan-002 `presence.*`, Plan-026 onboarding handlers, Tier 4 `run.*` / `repo.*` / `artifact.*` / `settings.*` / `daemon.*`) depends on this for boot-time correctness.

### I-007-7 — Schema validation runs before handler dispatch

Every JSON-RPC request MUST Zod-parse against the registered schema before the handler body executes. Validation failures map to JSON-RPC `-32602 Invalid Params` (per [F-007p-2-02 BLOCKED-ON-C7] error-mapping decision) and the handler is NEVER invoked.

**Why load-bearing.** Handlers must trust their typed input. A handler that runs on a malformed payload either crashes (degrades to internal-error responses) or produces garbage downstream (corrupts SQLite state, emits invalid events). Schema-validates-before-dispatch is the only invariant that pushes the validation responsibility off the handler author.

### I-007-8 — Handler-thrown errors map to JSON-RPC error codes with sanitized payloads

Errors thrown from handler bodies MUST map to JSON-RPC error codes per the [error-contracts.md JSON-RPC mapping] (BLOCKED-ON-C7) — registered domain codes (e.g. `session.not_found`, `auth.token_expired`) carry through to the client envelope; unregistered errors collapse to JSON-RPC `-32603 Internal Error` with sanitized message. Stack traces and secrets MUST never leak through the response.

**Why load-bearing.** Handler-thrown errors are the primary observability + security surface. Stack-trace leakage is a one-way information regression; collapsing all errors to `-32603` without preserving registered domain codes destroys the typed error envelope downstream consumers depend on.

### I-007-9 — Method names conform to the canonical format declared in api-payload-contracts.md

The registry MUST mechanically validate method-name format at `register(method, ...)` call time, refusing names that don't match the canonical convention. **BLOCKED-ON-C6** — the canonical format (dotted lowercase per F-007p-3-01 leaning, vs. slashed / PascalCase / camelCase) is undeclared in the corpus. Once declared in `api-payload-contracts.md` §Plan-007, a regex check at registration time is sufficient.

**Why load-bearing.** Without format enforcement, downstream plans may register `session.create`, `session/create`, `Session.create`, and `sessionCreate` simultaneously. The registry would treat these as distinct methods (correctly per the literal string) but the SDK consumer would have no way to choose. Format enforcement at registration time is the only mechanical guarantee.

### I-007-10 — Subscribe-init response precedes the first notification frame

For any subscription-establishing method (e.g. `session.subscribe`), the daemon MUST emit the JSON-RPC response carrying the assigned `subscriptionId` BEFORE the first `$/subscription/notify` frame referencing that id. Daemon enforcement uses `setImmediate(...)` (or equivalent macrotask deferral) to defer initial-replay emission until after the response envelope is queued on the transport. The paired SDK enforcement is synchronous dispatcher-entry registration inside `#handleResponse` (`packages/client-sdk/src/transport/jsonRpcClient.ts`), installed BEFORE the in-flight request promise resolves so that subsequent coalesced inbound frames within the same transport read can route to a known `subscriptionId`. Both sides are load-bearing; the invariant covers both.

**Why load-bearing.** Without daemon-side ordering enforcement, the SDK has no way to learn the `subscriptionId` before the first notify arrives — even synchronous SDK-side registration cannot install a dispatcher entry for an unknown id. Without SDK-side synchronous registration, the daemon's correct response-before-notify ordering is still insufficient under normal wire frame coalescing (a single transport read containing both the response and the first notify): the SDK's `.then`-deferred microtask would not run until after the next inbound frame is dispatched, dropping the first notification as an unknown-subscription. The pair is the contract; either side alone leaks first-notification reliability.

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred
- [ ] [api-payload-contracts.md](../architecture/contracts/api-payload-contracts.md) §Plan-007 declares `protocolVersion` field type (integer vs string), method-namespace registry typed surface (`registerNamespace`, `MethodRegistry`), JSON-RPC method-name format convention (e.g. `<namespace>.<verb>` dotted lowercase), and the `LocalSubscription<T>` streaming primitive shape — currently undeclared / contradicted across Spec-007:54 + api-payload-contracts.md:541-548 (BLOCKED-ON-C6 governance pickup)
- [ ] [error-contracts.md](../architecture/contracts/error-contracts.md) declares JSON-RPC numeric-error-space (`-32700` / `-32600` / `-32601` / `-32602` / `-32603`) ↔ project dotted-namespace ErrorResponse mapping; declares `unknown_setting` validation error envelope; declares the `resource.limit_exceeded` (or alternative) error code returned for oversized-body rejection (BLOCKED-ON-C7 governance pickup)
- [ ] [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md) §Event Type Summary registers `security.default.override` and `security.update.available` as canonical event types, and [Plan-006](./006-session-event-taxonomy-and-audit-log.md) emitter table lists Plan-007 as the emitter — currently absent on both sides (BLOCKED-ON-C9 governance pickup; same governance route as Spec-006 `member.joined` registration)
- [ ] `session.subscribe` streaming-primitive shape reconciled across `packages/contracts/src/session.ts:388` (currently SSE comment), [Plan-001](./001-shared-session-core.md) Phase 5:269 (currently `LocalSubscription`), and [api-payload-contracts.md §Plan-007](../architecture/contracts/api-payload-contracts.md):535-577 (currently `LocalSubscriptionParams` undefined-binding); ADR-009 amendment if substrate-level decision required (BLOCKED-ON-C6 governance pickup)
- [x] [Plan-001](./001-shared-session-core.md) Phase 2 schemas merged (`packages/contracts/src/session.ts` + `packages/contracts/src/event.ts`) — Phase 3 PR cannot open until Plan-001 Phase 2 is at HEAD

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Cross-Plan Obligations

The Tier 1 substrate Plan-007-partial ships at Phase 1-3 carries reciprocal obligations to downstream plans. This section makes those obligations visible to a Plan-007 reviewer without requiring them to read every consuming plan first. Mirrors the bidirectional-citation pattern established by [Plan-001 §Cross-Plan Obligations](./001-shared-session-core.md#cross-plan-obligations) (CP-001-1 / CP-001-2).

### CP-007-1 — `session.*` namespace contract owed to [Plan-001](./001-shared-session-core.md) Phase 5

Plan-007-partial Phase 3 owns the typed handlers + SDK Zod wrapper for `SessionCreate` / `SessionRead` / `SessionJoin` / `SessionSubscribe`. The contract surface includes (a) the canonical method-name strings (per [F-007p-3-01 BLOCKED-ON-C6] table in api-payload-contracts.md §Plan-007), (b) the request/response Zod schemas re-exported from `packages/contracts/src/session.ts` (Plan-001 Phase 2 ownership; imported transitively), and (c) the `LocalSubscription<EventEnvelope>` shape returned by `session.subscribe` (per [F-007p-3-02 BLOCKED-ON-C6] reconciliation across session.ts:388 / Plan-001:269 / api-payload-contracts.md:535-577).

**Why bidirectional.** Plan-001 Phase 5 (line 268-269) names `packages/client-sdk/src/sessionClient.ts` as Phase-5-owned and cites Plan-007-partial as the substrate Phase 5 imports. Without CP-007-1 on the Plan-007 side, the obligation is one-directional — Plan-001 reviewers see the dep but Plan-007 reviewers must reverse-search to find it.

### CP-007-2 — `presence.*` namespace contract owed to [Plan-002](./002-invite-membership-and-presence.md)

Plan-007-remainder (Tier 4) owns the substrate's namespace registry; Plan-002 (line 94) registers `presence.*` against that surface. The Tier 1 PR sequence does NOT ship the registry's typed surface — F-007p-2-03 (BLOCKED-ON-C6) escalates registry-shape definition to api-payload-contracts.md.

**Why bidirectional.** Plan-002 reviewers see the dependency on Plan-007's registry; Plan-007 reviewers (especially Tier 4 PR authors) must know that the registry's typed surface is contractually required to support Plan-002's registration before Plan-007-remainder lands.

### CP-007-3 — `router.register(method, handler)` registry surface owed to [Plan-026](./026-first-run-onboarding.md) and Tier 4 namespace plans

Plan-026 (line 236) imports the substrate's registry surface (`router.register(method, handler)`) for first-run-onboarding handlers. Tier 4 namespace plans (`run.*` / `repo.*` / `artifact.*` / `settings.*` / `daemon.*` per Plan-007-remainder) similarly register against the same surface. The typed shape is currently undeclared (BLOCKED-ON-C6).

**Why bidirectional.** Multiple downstream plans cite the surface informally (Plan-026:236, Plan-002:94, Tier 4 namespace remainders); the surface itself must be authoritatively typed once and re-cited.

### CP-007-4 — Typed JSON-RPC client transport (`packages/client-sdk/src/transport/`) owed to all client-SDK consumers

Plan-007-partial Phase 3 owns the transport-layer + Zod-wrapping primitive that every typed-JSON-RPC client surface (`sessionClient`, future `runClient` / `presenceClient` / etc.) consumes. Per [F-007p-3-03] resolution, the Tier 1 file split is:

- `packages/client-sdk/src/transport/jsonRpcClient.ts` — Plan-007 CREATE (transport-layer + Zod wrapping)
- `packages/client-sdk/src/transport/types.ts` — Plan-007 CREATE (`LocalSubscription<T>` type + `Handler<Req, Res>` shape)
- `packages/client-sdk/src/sessionClient.ts` — Plan-001 Phase 5 CREATE (session-specific client, imports the transport)

**Why bidirectional.** Plan-001 Phase 5 (line 268) and Plan-007-partial Phase 3 both name `packages/client-sdk/` as their delivery surface. Without CP-007-4, the file boundary between them is undefined and the two plans risk landing the same files.

### CP-007-5 — `security.default.*` event-type taxonomy registration owed to [Plan-006](./006-session-event-taxonomy-and-audit-log.md) / [Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md)

Plan-007-partial Phase 1 emits `security.default.override` (Spec-027:81+138+146 load-bearing) and Plan-007-remainder Tier 4 emits `security.update.available` (Spec-027 row 7a). Neither event is registered in Spec-006 §Event Type Summary (lines 486-510, 120 known event types) nor in Plan-006 emitter table (lines 80-100). **BLOCKED-ON-C9** — the governance route is the same as Spec-006 `member.joined` registration; once the registration mechanism is decided, both events register against it together with Plan-007 listed as the emitter plan.

**Why bidirectional.** Spec-027 line 146 makes the load-bearing claim ("visible to Spec-006 event taxonomy"); Plan-006 / Spec-006 are the consumers. Without CP-007-5, the bootstrap emitter would write its first event before the taxonomy knows about it.

## Target Areas

- `packages/contracts/src/daemon/`
- `packages/client-sdk/src/daemonClient.ts`
- `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts`
- `packages/runtime-daemon/src/ipc/protocol-negotiation.ts`
- `packages/runtime-daemon/src/bootstrap/secure-defaults.ts` — `SecureDefaults` configuration and enforcement layer (Spec-027 daemon-side rows)
- `packages/runtime-daemon/src/bootstrap/secure-defaults-events.ts` — `security.default.override=*` audit event emitters
- `packages/runtime-daemon/src/bootstrap/tls-surface.ts` — daemon TLS 1.3-only listener factory (Spec-027 row 8)
- `packages/runtime-daemon/src/bootstrap/first-run-keys.ts` — daemon first-run key generation (Spec-027 row 3 daemon scope)
- `packages/runtime-daemon/src/bootstrap/update-notify.ts` — Spec-027 row 7a notify-by-default poller
- `apps/cli/src/commands/self-update.ts` — Spec-027 row 7b dual-verification self-update (manifest sig + Sigstore bundle)
- `apps/desktop/shell/src/daemon-supervision/`
- `apps/desktop/renderer/src/daemon-status/`
- `apps/cli/src/`

## Data And Storage Changes

- Persist daemon version-compatibility diagnostics and reconnect metadata only where needed for actionable client status.
- No new shared control-plane storage is required for the local IPC contract itself.

## API And Transport Changes

- Add `DaemonHello`, `DaemonHelloAck`, `DaemonStatusRead`, `DaemonStart`, `DaemonStop`, `DaemonRestart`, and shared subscription primitives to the typed client SDK.
- Implement OS-local socket or pipe transport as the default client path, with explicit loopback fallback hooks.

## CLI Delivery Track

- The first shipped client for the typed daemon contract is `apps/cli/`.
- CLI delivery must cover daemon handshake, lifecycle status, session read or create or join, and run-state subscription over the shared client SDK.
- Desktop shell supervision and renderer status surfaces follow on the same stabilized daemon contract rather than defining a second local client path.

## Secure Defaults (Spec-027 daemon-side rows)

Plan-007 owns the daemon-side enforcement of [Spec-027 §Required Behavior](../specs/027-self-host-secure-defaults.md#required-behavior) rows 2, 3, 4, 7a, 7b, 8, and 10. The enforcement layer is a typed `SecureDefaults` configuration module that runs in the daemon bootstrap path before any listener starts, validates overrides explicitly, fails closed on invalid settings, emits audit events, and exposes only typed non-secret effective settings to downstream daemon modules.

| Spec-027 Row | Daemon-Side Behavior | `SecureDefaults` Enforcement Point |
| --- | --- | --- |
| 2 — Refuse to start without encryption on non-loopback bind | Config parser rejects `<non-loopback bind> + <no TLS>` combination with non-zero exit; `--insecure` override emits loud banner + `security.default.override=insecure_bind` log event | `secure-defaults.ts` + `secure-defaults-events.ts` |
| 3 — Auto-generated strong secrets on first run (daemon keys) | Daemon master key (Spec-022) + session-signing key generated via `crypto.randomBytes(N ≥ 32)` on first run; persisted `0600` (Unix) / ACL (Windows); fingerprints printed to stdout AND on-disk file header comment (`age-keygen` pattern); `./data/trust/first-run.complete` sentinel required before subsequent boots | `first-run-keys.ts` |
| 4 — Loopback bind by default (daemon) | `DAEMON_BIND` defaults to `127.0.0.1`; daemon local-IPC socket and daemon HTTP listener both loopback-only by default; `DAEMON_BIND=0.0.0.0` permitted only in conjunction with TLS (row 2 interaction) | `secure-defaults.ts` |
| 7a — Auto-update notify-by-default (daemon) | Daemon polls GitHub Releases (or operator-configured feed) on a cadence owned by this plan; newer release → CLI invocation prompt + first-run-banner line + `security.update.available` log event; daemon MUST NOT self-swap while IPC is live | `update-notify.ts` |
| 7b — Opt-in self-update (CLI) | `ai-sidekicks self-update` fetches manifest + Sigstore bundle; verifies **both** Ed25519 manifest signature AND Sigstore attestation; passing either alone is insufficient; manifest anti-rollback/freeze via `version` monotonic + `previous_manifest_hash` + `next_signing_keys` + `expires_at`; atomic swap + re-exec with platform-specific rules | `apps/cli/src/commands/self-update.ts` |
| 8 — TLS 1.3 minimum | All daemon TLS surfaces (daemon HTTPS, WebSocket Secure) negotiate TLS 1.3 only via `{minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3'}` on `tls.createServer` / `https.createServer`; TLS ≤ 1.1 rejected outright (RFC 8996); `--legacy-tls12` override permits 1.2 with loud banner + `security.default.override=legacy_tls12` log event | `tls-surface.ts` |
| 10 — Loud first-run banner (daemon content) | On every daemon process start, single-screen stdout banner enumerates: TLS mode + fingerprint (if self-signed/internal-CA), effective bind addresses, backup destination + cadence, admin-token file path, update channel + mode, any active `security.default.override=*` rows; format owned by Plan-026, content provided by `SecureDefaults.effectiveSettings` view; `BANNER_FORMAT=json` emits same payload as single JSON line | `secure-defaults.ts` exposes content contract; `first-run-banner` consumer in Plan-026 |

**Invariants.** See top-level §Invariants — I-007-1 (load-before-bind), I-007-2 (fail-closed), I-007-3 (`effectiveSettings` non-secret only), I-007-4 (single override-event emission), I-007-5 (validation surface widens with bind surface). The invariants govern this entire §Secure Defaults table; the top-level placement makes them discoverable to consumers (Plan-001 Phase 5, Plan-002 `presence.*`, Plan-003 attach calls) without requiring them to read this section first.

**Override coverage (audit-visible).** Every row with an override path listed in [Spec-027 §Fallback Behavior](../specs/027-self-host-secure-defaults.md#fallback-behavior) emits the override's `security.default.override=*` log event through `secure-defaults-events.ts`. Banner output (row 10) enumerates active overrides on every startup.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.
- Tier markers below correspond to §Execution Windows (V1 Carve-Out): `[Tier 1]` = ships in Plan-007-partial alongside Plan-001; `[Tier 4]` = ships in Plan-007-remainder.

1. **[Tier 1: `session.*` only; Tier 4: rest]** Define daemon handshake, lifecycle, and subscription contracts in shared packages. The `session.*` namespace contracts (`SessionCreate`, `SessionRead`, `SessionJoin`, `SessionSubscribe`) ship in the Tier 1 partial — they are Plan-001 vertical-slice contracts that already live in `packages/contracts/src/session.ts`. The `run.*`, `repo.*`, `artifact.*`, `settings.*`, and `daemon.*` namespace contracts ship in Tier 4 alongside the corresponding handlers.
2. **[Tier 1: `secure-defaults.ts` + `secure-defaults-events.ts` (validation scope limited to loopback OS-local socket binding; Tier-4-scope keys refused with `unknown_setting` per fail-closed invariant); Tier 4: `tls-surface.ts` + `first-run-keys.ts` + `update-notify.ts` + Spec-027 row coverage extension as bind paths widen]** Implement `SecureDefaults` configuration + enforcement layer covering Spec-027 rows 2, 3, 4, 7a, 8, 10 (split per the bracketed Tier 1 / Tier 4 file scopes above; row-by-row tier mapping in [`cross-plan-dependencies.md` §Plan-007 Substrate-vs-Namespace Carve-Out](../architecture/cross-plan-dependencies.md#plan-007-substrate-vs-namespace-carve-out-tier-1--tier-4)); wire it as the first step of daemon bootstrap before any listener binds. The Tier 1 partial validates the bind paths it actually exposes (loopback OS-local socket only); Tier 4 widens validation as additional bind paths (HTTP, non-loopback, TLS) and Spec-027 surfaces (`tls-surface.ts`, `first-run-keys.ts`, `update-notify.ts`) are introduced.
3. **[Tier 4]** Implement daemon TLS 1.3-only listener factory (`tls-surface.ts`) and first-run key ceremony (`first-run-keys.ts`).
4. **[Tier 4]** Implement update-notify poller (`update-notify.ts`, row 7a) and CLI self-update dual-verification command (`apps/cli/src/commands/self-update.ts`, row 7b).
5. **[Tier 1: substrate + loopback-bind validation via `effectiveSettings`; Tier 4: extended bind-path validation]** Implement OS-local IPC gateway (`local-ipc-gateway.ts`) and protocol-version negotiation (`protocol-negotiation.ts`) in the Local Runtime Daemon. The Tier 1 partial ships the substrate (JSON-RPC 2.0 + LSP-style Content-Length framing, 1MB max-message-size, error model, supervision hooks, OS-local socket / named-pipe transport, gated loopback fallback) plus the SDK Zod layer (~500–1000 LOC per [Spec-007 §Wire Format](../specs/007-local-ipc-and-daemon-control.md#wire-format)) and the `session.*` namespace handlers; the gateway consumes `SecureDefaults.effectiveSettings` for the loopback OS-local bind path. Tier 4 widens what `effectiveSettings` exposes (TLS mode, non-loopback bind, additional override flags) as the corresponding bind paths enter the daemon.
6. **[Tier 4]** Implement the CLI on top of the same client SDK and daemon contract rather than embedding daemon logic directly.
7. **[Tier 4]** Implement desktop-shell daemon supervision and actionable startup or reconnect status surfaces on the same stabilized contract.

## Tier 1 Partial PR Sequence

The Tier 1 partial slice (per §Execution Windows above) lands as **3 small PRs** following the substrate-vs-namespace decomposition rule. Each PR is reviewable in isolation. The Tier 4 remainder PR breakdown is deferred to plan-execution time when Tier 4 begins.

### Phase 1: SecureDefaults Bootstrap (loopback-bind validation only)

**Goal:** Spec-027 daemon-side bind-time substrate ships at the validation surface Tier 1 actually exposes. `SecureDefaults.load` runs before any listener binds; fail-closed enforcement is active; Tier-4-scope settings keys (TLS, non-loopback, first-run-keys) are refused with `unknown_setting`.

**Precondition:** None at the plan level. Tier 1 entry point.

- `packages/runtime-daemon/src/bootstrap/secure-defaults.ts` — `SecureDefaults.load(config)` + `effectiveSettings()` API, validation scope limited to the loopback OS-local socket bind path Tier 1 exposes (rows 4 + 10 of the §Secure Defaults table above).
- `packages/runtime-daemon/src/bootstrap/secure-defaults-events.ts` — `security.default.override=*` audit event emitter (single emit per startup, not per request).
- Wire `SecureDefaults.load` as the first step of daemon bootstrap, before `local-ipc-gateway` opens its listener (per §Invariants above).
- Tests: `SecureDefaults.load` invariant tests (load-before-bind enforcement throws on out-of-order; fail-closed on invalid config; `effectiveSettings` never exposes secrets); negative-path test that Tier-4-scope settings keys are refused with `unknown_setting` error.

#### Tasks

- **T-007p-1-1** (Files: `packages/runtime-daemon/src/bootstrap/secure-defaults.ts`; Verifies invariant: I-007-1 + I-007-2 + I-007-3 + I-007-5; Spec coverage: Spec-027 rows 4 + 10) — Implement `SecureDefaults.load(config)` and `effectiveSettings()` with conservative inline contract types (config = `{ bindAddress: string; bindPort?: number; localIpcPath: string; bannerFormat: 'text' | 'json' }`; effectiveSettings return = same shape minus any future secret-bearing fields). **BLOCKED-ON-C6** — when api-payload-contracts.md §Plan-007 lands the authoritative `SecureDefaults` config schema, replace the inline shape with the imported types and update I-007-3's "non-secret typed values" assertion against the canonical schema. Validation scope: refuse unknown keys (Tier-4-scope: `tlsMode`, `firstRunKeysPolicy`, `nonLoopbackHost`) with `unknown_setting` validation error per I-007-5. Fail closed on invalid loopback bind (e.g. unreachable interface, port already bound, malformed path). Tests: W-007p-1-T1 load-before-bind throws (I-007-1); W-007p-1-T2 fail-closed on invalid config (I-007-2); W-007p-1-T3 effectiveSettings exposes no secrets (I-007-3); W-007p-1-T4 Tier-4-scope keys refused with `unknown_setting` (I-007-5).
- **T-007p-1-2** (Files: `packages/runtime-daemon/src/bootstrap/secure-defaults-events.ts`; Verifies invariant: I-007-4; Spec coverage: Spec-027 row 10 + line 81+138+146) — Implement single-emit-per-startup `security.default.override=<behavior>` audit event emitter with payload `{ behavior, row, effective_value, banner_printed_at }` per Spec-027:138. Emit at most once per override per process startup (NOT per request, NOT per event batch). The event MUST be marked-but-unregistered at Tier 1 (taxonomy registration is BLOCKED-ON-C9 governance pickup per CP-007-5); the emitter's contract is "fire to whatever event sink the daemon bootstrap exposes". Tests: W-007p-1-T5 single-emit-per-startup (I-007-4) — multiple override paths with different behaviors emit independently but each only once.
- **T-007p-1-3** (Files: `packages/runtime-daemon/src/bootstrap/index.ts` + `secure-defaults.ts` consumer wiring; Verifies invariant: I-007-1) — Wire `SecureDefaults.load(config)` as the FIRST step of daemon bootstrap, before any listener `bind()` call. Bootstrap orchestrator MUST throw on attempted bind without prior `SecureDefaults.load` completion. Cite [ADR-006](../decisions/006-worktree-first-execution-mode.md) for daemon-as-execution-authority context inline at the bootstrap step.
- **T-007p-1-4** (Files: `packages/runtime-daemon/src/bootstrap/__tests__/secure-defaults.test.ts`; Verifies all I-007-1..5 at Tier 1 scope) — Author the W-007p-1-T1..T5 test suite. The `unknown_setting` error envelope shape is BLOCKED-ON-C7 — until error-contracts.md JSON-RPC mapping lands, T-007p-1-4 asserts on the error code STRING (`"unknown_setting"`) only; full envelope-shape assertion is added in a follow-up amendment when C-7 resolves.

### Phase 2: Wire Substrate

**Goal:** Spec-007 §Wire Format substrate ships behind passing handshake + transport tests. No `session.*` handlers yet — this PR delivers the JSON-RPC + framing layer only.

**Precondition:** Phase 1 merged (the wire substrate consumes `SecureDefaults.effectiveSettings` for the loopback OS-local bind path).

- `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts` — JSON-RPC 2.0 dispatcher with LSP-style Content-Length framing (`Content-Length: <byte-count>\r\n\r\n`), 1MB max-message-size enforcement, typed error model (`packages/contracts/src/error.ts` shapes), supervision hooks, and OS-local socket / Windows named-pipe transport (default) with gated loopback fallback per [Spec-007 §Wire Format](../specs/007-local-ipc-and-daemon-control.md#wire-format) and [Spec-007 §Fallback Behavior](../specs/007-local-ipc-and-daemon-control.md#fallback-behavior).
- `packages/runtime-daemon/src/ipc/protocol-negotiation.ts` — `DaemonHello` / `DaemonHelloAck` exchange, protocol-version pinning, mutating-operation gate when versions are incompatible per [Spec-007 §Required Behavior](../specs/007-local-ipc-and-daemon-control.md#required-behavior).
- Tests: handshake + version-negotiation compatibility tests; transport tests for Unix socket, named pipe, and gated loopback fallback (per §Test And Verification Plan above).

#### Tasks

- **T-007p-2-1** (Files: `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts` + `packages/contracts/src/jsonrpc.ts` (CREATE if not present); Verifies invariant: I-007-7 + I-007-8; Spec coverage: Spec-007 §Wire Format + ADR-009) — Implement JSON-RPC 2.0 dispatcher with LSP-style Content-Length framing (`Content-Length: <byte-count>\r\n\r\n`) per [ADR-009](../decisions/009-json-rpc-ipc-wire-format.md). The `protocolVersion` field type contradiction (Spec-007:54 integer vs api-payload-contracts.md:541-548 string) is **BLOCKED-ON-C6** — until reconciled, T-007p-2-1 ships the framing parser parameterized over `protocolVersion: number | string` and Phase 3 handlers narrow once the canonical type is declared. The 1MB max-message-size limit is **hard-coded in the substrate** (per F-007p-2-11 conservative resolution) — changes require a Phase 2 amendment + Spec-007 update. Per F-007p-2-12, the supervision-hook surface is `{ onConnect(transport): void; onDisconnect(transport, reason): void; onError(transport, err): void }` exported from the gateway for the Tier 4 desktop-shell supervision surface to consume (Plan-007-remainder picks up the consumer side).
- **T-007p-2-2** (Files: `packages/runtime-daemon/src/ipc/jsonrpc-error-mapping.ts` (CREATE) + `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts` consumer wiring; Verifies invariant: I-007-7 + I-007-8) — **BLOCKED-ON-C7**. Implement the JSON-RPC numeric-error-space (`-32700` parse error / `-32600` invalid request / `-32601` method not found / `-32602` invalid params / `-32603` internal error) ↔ project dotted-namespace ErrorResponse mapping. Until error-contracts.md authoritative mapping lands, ship a conservative inline mapping table in this file: parse failure → `-32700`; missing/malformed JSON-RPC envelope → `-32600`; unregistered method → `-32601`; Zod validation failure → `-32602` with the project dotted code carried in `error.data`; handler-thrown registered domain error → preserves dotted code in `error.data`, JSON-RPC `code` selected per error-contracts mapping; unhandled exception → `-32603` with sanitized message. Oversized-body rejection (per F-007p-2-05): close the connection with a JSON-RPC error frame matching `-32600` invalid-request and emit a `resource.limit_exceeded` event in `error.data` — once C-7 lands, replace with the canonical envelope.
- **T-007p-2-3** (Files: `packages/runtime-daemon/src/ipc/registry.ts` (CREATE) + `packages/contracts/src/jsonrpc-registry.ts` (CREATE if not present); Verifies invariant: I-007-6 + I-007-7 + I-007-9; Spec coverage: §Cross-Plan Obligations CP-007-3) — **BLOCKED-ON-C6**. Implement the method-namespace registry typed surface. Conservative inline shape: `interface MethodRegistry { register<P, R>(method: string, paramsSchema: ZodSchema<P>, resultSchema: ZodSchema<R>, handler: (params: P, ctx: HandlerContext) => Promise<R>, opts?: { mutating?: boolean }): void; dispatch(method: string, params: unknown, ctx: HandlerContext): Promise<unknown>; has(method: string): boolean; }`. Per F-007p-2-06, the read-vs-mutating classification is the optional `mutating: boolean` flag at registration time; the substrate uses this flag for the version-mismatch gate (refuse mutating ops when `DaemonHelloAck.compatible === false`; allow read-only methods through). When C-6 resolves the canonical method-name format, add the regex check at register-time per I-007-9. Tests: T-007p-2-T1 duplicate registration rejected (I-007-6); T-007p-2-T2 schema-validates-before-dispatch (I-007-7); T-007p-2-T3 method-name regex validation (I-007-9, post-C-6).
- **T-007p-2-4** (Files: `packages/runtime-daemon/src/ipc/protocol-negotiation.ts`; Verifies invariant: I-007-7; Spec coverage: Spec-007 §Required Behavior line 47 + §Fallback Behavior line 67-68) — Implement `DaemonHello` / `DaemonHelloAck` exchange. Negotiation algorithm (per F-007p-2-10 resolution): daemon selects `max(client.supportedProtocols ∩ daemon.supported)` by semver; if intersection is empty, return `version.floor_exceeded` (client too old) or `version.ceiling_exceeded` (client too new) error per error-contracts.md (BLOCKED-ON-C7 envelope shape) and refuse all subsequent mutating ops via the registry's `mutating: boolean` flag check. The per-request `protocolVersion` integer field (per Spec-007:54, BLOCKED-ON-C6) is the major version derived from `negotiatedProtocol`. Loopback-fallback gate (per F-007p-2-09): the gate is the SecureDefaults validation surface — Tier 1 only allows loopback OS-local transport; loopback-fallback transport requires explicit operator opt-in via a config key NOT YET DEFINED at Tier 1 (deferred to Tier 4 with non-loopback bind). At Tier 1, attempting loopback-fallback fails with `transport.unavailable` (BLOCKED-ON-C7 for envelope).
- **T-007p-2-5** (Files: `packages/runtime-daemon/src/ipc/streaming-primitive.ts` (CREATE) + `packages/contracts/src/jsonrpc-streaming.ts` (CREATE); Verifies invariant: I-007-7) — **BLOCKED-ON-C6**. Implement the `LocalSubscription<T>` JSON-RPC streaming primitive at Phase 2 (per F-007p-2-14 — primitive ships with substrate, handler binding ships at Phase 3). Conservative inline shape: initial response `{ subscriptionId: string }`; notification frame `{ jsonrpc: "2.0", method: "$/subscription/notify", params: { subscriptionId: string, value: T } }` (LSP `$/cancelRequest` pattern); cancel via `$/subscription/cancel` method (params: `{ subscriptionId }`). Server-side cleanup on transport disconnect. Tests: T-007p-2-T4 subscribe round-trip (initial response + N notifications + cancel + cleanup verified). Once C-6 reconciles session.ts:388 / Plan-001:269 / api-payload-contracts.md:535-577, this file becomes the authoritative streaming primitive Plan-001 Phase 5 imports.
- **T-007p-2-6** (Files: `packages/runtime-daemon/src/ipc/__tests__/local-ipc-gateway.test.ts` + `protocol-negotiation.test.ts` + `registry.test.ts` + `streaming-primitive.test.ts`) — Author Phase 2 test suite: W-007p-2-T1 handshake + version-negotiation compatibility (Spec-007 line 47); W-007p-2-T2 transport for Unix domain socket; W-007p-2-T3 transport for Windows named pipe; W-007p-2-T4 transport: gated loopback fallback fails at Tier 1 with `transport.unavailable` (per F-007p-2-09 Tier 1 conservative gate); W-007p-2-T5 1MB max-message-size enforcement → connection close + `-32600` error frame (per F-007p-2-05); W-007p-2-T6 Content-Length framing parser correctness (single message, multi-message buffer, malformed framing → connection close); W-007p-2-T7 method-not-found → `-32601` (per F-007p-2-04 + I-007-9 namespace-isolation); W-007p-2-T8 mutating-op gate when `DaemonHelloAck.compatible === false` (per Spec-007:67-68); W-007p-2-T9 schema-validates-before-dispatch → handler not invoked on malformed payload, `-32602` returned (I-007-7); W-007p-2-T10 handler-thrown error → `-32603` (no stack/secret leak, I-007-8); W-007p-2-T11 streaming primitive round-trip + cancel cleanup (I-007-7 streaming variant). Cite [ADR-009](../decisions/009-json-rpc-ipc-wire-format.md) inline in the gateway test file's header comment per F-007p-2-08.

### Phase 3: `session.*` Handlers + SDK Zod Layer

**Goal:** `session.*` JSON-RPC namespace ships end-to-end behind passing handler tests; client SDK Zod wrapper exposes the daemon transport with typed schemas. Plan-001 Phase 5 unblocks on this PR's merge (in conjunction with Plan-008 bootstrap Phase 1).

**Precondition:** Phase 1 + Phase 2 merged.

- `session.*` namespace handlers in the daemon — typed JSON-RPC handlers for `SessionCreate`, `SessionRead`, `SessionJoin`, `SessionSubscribe` (the Plan-001 vertical-slice contracts already in `packages/contracts/src/session.ts`). No `run.*` / `repo.*` / `artifact.*` / `settings.*` / `daemon.*` handlers — those ship in Plan-007-remainder at Tier 4.
- `packages/client-sdk/` — Zod-wrapped typed SDK (~500–1000 LOC per [Spec-007 §Wire Format](../specs/007-local-ipc-and-daemon-control.md#wire-format)) following the MCP TypeScript SDK pattern. Exposes `session.*` methods over the daemon transport.
- Tests: `session.*` handler integration tests (create / read / join / subscribe round-trip through the wire substrate); SDK Zod-validation tests covering malformed-payload rejection.

#### Tasks

- **T-007p-3-1** (Files: `packages/runtime-daemon/src/ipc/handlers/session-create.ts` + `session-read.ts` + `session-join.ts` + `session-subscribe.ts`; Verifies invariant: I-007-7 + I-007-8; Spec coverage: §Cross-Plan Obligations CP-007-1) — **BLOCKED-ON-C6** (method-name strings) + **BLOCKED-ON-C6** (subscribe streaming-primitive shape). Implement the four `session.*` handlers binding into the registry from T-007p-2-3. Each handler imports the request/response Zod schemas from `packages/contracts/src/session.ts` (Plan-001 Phase 2 ownership; precondition per §Dependencies). Conservative method-name strings: `session.create` / `session.read` / `session.join` / `session.subscribe` (dotted-lowercase per F-007p-3-01 leaning); replace with the canonical strings once C-6's `api-payload-contracts.md §Plan-007` method-name table lands. Handler signatures per F-007p-3-08 code-surface example:

  ```typescript
  // Daemon side
  type Handler<Req, Res> = (params: Req, ctx: HandlerContext) => Promise<Res>;
  router.register<SessionCreateRequest, SessionCreateResponse>(
    "session.create", // BLOCKED-ON-C6: pin canonical string
    SessionCreateRequestSchema,
    SessionCreateResponseSchema,
    sessionCreateHandler,
    { mutating: true },
  );
  router.register<SessionSubscribeRequest, SessionSubscribeResponse>(
    "session.subscribe",
    SessionSubscribeRequestSchema,
    SessionSubscribeResponseSchema,
    sessionSubscribeHandler,
    { mutating: false },
  );
  ```

  Subscribe handler returns `LocalSubscription<EventEnvelope>` per the streaming primitive from T-007p-2-5; the EventEnvelope shape comes from Plan-001 Phase 2 (`packages/contracts/src/event.ts`). Per F-007p-3-06, Spec-007 §Acceptance Criteria amendment is required to add per-method ACs (AC-N1..N4) — this is OUT-OF-PLAN-BODY work tracked at the spec level.

- **T-007p-3-2** (Files: `packages/client-sdk/src/transport/jsonRpcClient.ts` (CREATE) + `packages/client-sdk/src/transport/types.ts` (CREATE); Verifies invariant: §Cross-Plan Obligations CP-007-4; Spec coverage: Spec-007:56 ~500-1000 LOC ballpark) — Implement the typed JSON-RPC transport-layer + Zod-wrapping primitive following the [MCP TypeScript SDK pattern](https://github.com/modelcontextprotocol/typescript-sdk) (per F-007p-3-10 — link the primary source in Spec-007:56 amendment). The transport file owns:

  ```typescript
  // packages/client-sdk/src/transport/jsonRpcClient.ts
  export class JsonRpcClient {
    constructor(transport: ClientTransport, opts?: { protocolVersion?: number | string });
    call<P, R>(
      method: string,
      params: P,
      paramsSchema: ZodSchema<P>,
      resultSchema: ZodSchema<R>,
    ): Promise<R>;
    subscribe<T>(method: string, params: unknown, valueSchema: ZodSchema<T>): LocalSubscription<T>;
  }
  // packages/client-sdk/src/transport/types.ts
  export interface LocalSubscription<T> {
    subscriptionId: string;
    next(): Promise<T | undefined>;
    cancel(): Promise<void>;
    [Symbol.asyncIterator](): AsyncIterator<T>;
  }
  export type Handler<Req, Res> = (params: Req, ctx: HandlerContext) => Promise<Res>;
  ```

  Per F-007p-3-03 SDK file boundary resolution: this file is **Plan-007 CREATE**. Plan-001 Phase 5 EXTENDs by creating `packages/client-sdk/src/sessionClient.ts` (Plan-001 OWN per Plan-001:268) which imports `JsonRpcClient` from this file. Cross-plan-deps amendment required to encode the CREATE/EXTEND split.

- **T-007p-3-3** (Files: `packages/client-sdk/src/sessionClient.ts` reference verification + Plan-001 Phase 5 coordination handoff) — **NOTE**: this task does NOT create `sessionClient.ts` — that file is Plan-001 Phase 5 owned (per F-007p-3-03 resolution + CP-007-4). T-007p-3-3 verifies that the transport surface from T-007p-3-2 satisfies Plan-001 Phase 5's `sessionClient` import requirements: methods `transport.call("session.create", ...)`, `transport.call("session.read", ...)`, `transport.call("session.join", ...)`, `transport.subscribe("session.subscribe", ...)` are all callable from `sessionClient.ts`. If any signature divergence is discovered, surface as a C-6 escalation (method-name canonical-format reconciliation may require updating the transport API). **Spec coverage:** Spec-007 §Acceptance Criteria — daemon subscribability via local IPC (transport.call / transport.subscribe invocability for `session.create`, `session.read`, `session.join`, `session.subscribe`).
- **T-007p-3-4** (Files: `packages/runtime-daemon/src/ipc/handlers/__tests__/session-handlers.test.ts` + `packages/client-sdk/src/transport/__tests__/jsonRpcClient.test.ts`) — Author Phase 3 test suite per F-007p-3-09 Test ID format:
  - **I-007-3-T1** round-trip `session.create` over JSON-RPC; assert response matches SessionCreateResponseSchema; SQLite session row created; creation event emitted.
  - **I-007-3-T2** malformed `session.create` payload rejected with JSON-RPC `-32602`; handler not invoked (I-007-7).
  - **I-007-3-T3** `session.subscribe` initial response carries `subscriptionId`; subsequent notifications correlate; cancellation cleans up server resources (I-007-7 streaming variant + T-007p-2-5 primitive). **BLOCKED-ON-C6** — the streaming-primitive frame shape may shift when reconciliation lands; test currently asserts on the conservative inline shape from T-007p-2-5.
  - **I-007-3-T4** SDK Zod wrapper validates response payloads; corrupted server response surfaces as typed SDK error (not silent partial); the SDK does NOT swallow validation errors.
  - **I-007-3-T5** duplicate `router.register("session.create", ...)` rejected at registration time (I-007-6 verification path).

After Phase 3 merges (and Plan-008 bootstrap Phase 1 also merges), [Plan-001 Phase 5](./001-shared-session-core.md#phase-5--client-sdk-and-desktop-bootstrap) consumer can begin.

## Parallelization Notes

- IPC contract work and shell supervision scaffolding can proceed in parallel once handshake semantics are fixed.
- CLI work can begin as soon as the shared client SDK contract is stable and should finish before renderer-specific daemon control surfaces.

## Test And Verification Plan

Tests are scoped per execution window. Tier 1 tests gate Tier 1 PRs (#1–#3 above); Tier 4 tests gate the Plan-007-remainder PRs.

### [Tier 1] Plan-007-Partial Tests

Validation surface scoped to the loopback OS-local socket bind path Tier 1 exposes. Test IDs prefix mapping: **W** = wire/bootstrap (Phase 1-2 substrate), **I** = integration (Phase 3 handler round-trip), **T-007p-N-M** = task-level test reference.

#### Phase 1 — SecureDefaults Bootstrap (W-007p-1-T1..T5)

- **W-007p-1-T1** (Verifies I-007-1) `packages/runtime-daemon/src/bootstrap/__tests__/secure-defaults.test.ts`: Load-before-bind. Attempting to bind the local-IPC gateway before `SecureDefaults.load` completes throws synchronously.
- **W-007p-1-T2** (Verifies I-007-2) Fail-closed. Invalid config produces typed error with actionable message; no "best-effort partial start" path exists.
- **W-007p-1-T3** (Verifies I-007-3) `effectiveSettings` exposes only non-secret typed values; never raw keys or secrets. Property test over the conservative config schema verifies no field tagged `secret: true` (post-C-6 type-level marker) leaks through.
- **W-007p-1-T4** (Verifies I-007-5) Tier-4-scope-key refusal. TLS configuration keys (`tlsMode`, `tlsCertPath`), non-loopback host keys (`nonLoopbackHost`), first-run-keys policy keys (`firstRunKeysPolicy`) are refused with `unknown_setting` validation error at Tier 1. Until C-7 lands, asserts on error code STRING only; envelope-shape assertion deferred.
- **W-007p-1-T5** (Verifies I-007-4) Single override-event emission. Each override emits its `security.default.override=<behavior>` event exactly once per startup. Multi-override scenario: two distinct overrides each emit their own event exactly once.

Spec-027 row coverage at Tier 1 (rows 4 + 10 only — bind-path-relevant rows the loopback OS-local surface exposes):

- Row 4 verification: daemon defaults to `127.0.0.1`; the loopback OS-local socket binds to the local namespace only.
- Row 10 verification: first-run banner content contract — `effectiveSettings` view supplies the row-10 fields the Plan-026-owned banner consumer renders. Tier 1 verifies the content contract; banner format itself ships with Plan-026.

#### Phase 2 — Wire Substrate (W-007p-2-T1..T11)

- **W-007p-2-T1** (Spec-007 line 47) Handshake + version-negotiation compatibility. `DaemonHello` / `DaemonHelloAck` exchange; mutating-operation gate when `compatible === false`.
- **W-007p-2-T2** Transport: Unix domain socket round-trip.
- **W-007p-2-T3** Transport: Windows named pipe round-trip.
- **W-007p-2-T4** (per F-007p-2-09 Tier 1 conservative gate) Transport: gated loopback fallback. At Tier 1, attempting loopback-fallback fails with `transport.unavailable` error code (BLOCKED-ON-C7 envelope). Tier 4 widens the test to verify the explicit-auth gate.
- **W-007p-2-T5** (per F-007p-2-05) 1MB max-message-size enforcement. Body > 1MB → connection close + `-32600` error frame; subsequent reconnect succeeds.
- **W-007p-2-T6** Content-Length framing parser correctness. Single message; multi-message buffer; partial read; malformed framing → connection close.
- **W-007p-2-T7** (per F-007p-2-04 + I-007-9) Method-not-found namespace-isolation. Invoking an unregistered method (e.g. `not.registered`) returns JSON-RPC `-32601` per F-007p-2-02 mapping; never falls through to a generic dispatch path.
- **W-007p-2-T8** (per Spec-007:67-68) Mutating-op gate when version-mismatch. Read methods pass through; mutating methods refused per the registry's `mutating: boolean` flag.
- **W-007p-2-T9** (Verifies I-007-7) Schema-validates-before-dispatch. Malformed payload returns JSON-RPC `-32602`; handler is NEVER invoked.
- **W-007p-2-T10** (Verifies I-007-8) Handler-thrown error mapping. Thrown unhandled exception → JSON-RPC `-32603` with sanitized message; no stack/secret leak.
- **W-007p-2-T11** (Verifies I-007-7 streaming + T-007p-2-5 primitive) `LocalSubscription<T>` round-trip. Initial response carries `subscriptionId`; N notifications correlate; cancel cleans up server resources; transport disconnect triggers server-side cleanup. **BLOCKED-ON-C6** — frame shape may shift when reconciliation lands.

#### Phase 3 — `session.*` Handlers + SDK Zod Layer (I-007-3-T1..T5)

- **I-007-3-T1** Round-trip `session.create` over JSON-RPC. Asserts response matches `SessionCreateResponseSchema`; SQLite session row created (verified via Plan-001 Phase 4 directory service); creation event emitted.
- **I-007-3-T2** (Verifies I-007-7) Malformed `session.create` payload rejected with JSON-RPC `-32602`; handler NEVER invoked.
- **I-007-3-T3** (Verifies I-007-7 streaming + CP-007-1 + BLOCKED-ON-C6) `session.subscribe` initial response carries `subscriptionId`; subsequent notifications correlate to the originating subscribe; cancellation cleans up server resources.
- **I-007-3-T4** (Verifies CP-007-4) SDK Zod wrapper validates response payloads. Corrupted server response surfaces as typed SDK error; the SDK does NOT swallow validation errors.
- **I-007-3-T5** (Verifies I-007-6) Duplicate `router.register("session.create", ...)` rejected at registration time (programmer error surfaced synchronously during daemon bootstrap).

### [Tier 4] Plan-007-Remainder Tests

Validation surface widens at Tier 4 alongside the additional bind paths (HTTP, non-loopback, TLS) and the four other JSON-RPC namespaces. Per §Invariants I-007-5, the row coverage extends here.

- Spec-027 row coverage at Tier 4 (rows 2, 3, 7a, 7b, 8 — the bind-path-widening rows):
  - Row 2: daemon refuses to start when `<non-loopback bind> + <no TLS>`; `--insecure` override boots with banner + `security.default.override=insecure_bind` event emitted exactly once.
  - Row 3: first-run ceremony generates keys with `N ≥ 32` bytes of entropy (test the entropy source); persisted-file permissions verified (`0600` Unix; ACL Windows); fingerprint appears in both stdout and on-disk file header; sentinel absence blocks subsequent starts with actionable error.
  - Row 7a: update poller emits `security.update.available` event when newer release detected; daemon refuses self-swap while IPC socket has active clients.
  - Row 7b: self-update CLI rejects manifest where only Ed25519 passes but Sigstore fails; rejects manifest where only Sigstore passes but Ed25519 fails; rejects manifest with `version <= last_seen_version`; rejects manifest with `now > expires_at`; atomic swap + re-exec verified on Linux, macOS, Windows.
  - Row 8: TLS surface negotiates 1.3 only — test rejects 1.2 handshake outright unless `LEGACY_TLS12=1` + banner emitted; test rejects 1.1 and 1.0 even with legacy flag (RFC 8996 floor).
- `run.*` / `repo.*` / `artifact.*` / `settings.*` / `daemon.*` namespace handler integration tests.
- Tier-4-scope settings keys NOW accepted by `SecureDefaults` (the inverse of the I-007-5 negative-path test from Tier 1).
- Manual verification that desktop renderer and CLI reach the same daemon semantics through the same typed SDK.

## Rollout Order

1. Land shared daemon contracts and SDK surface
2. Ship the first CLI against the same local daemon contract
3. Enable desktop-shell supervision and daemon status reads

## Rollback Or Fallback

- Disable auto-start and loopback fallback features while preserving typed status reads if transport rollout regresses.

## Risks And Blockers

- Browser-only client support remains unresolved and may pressure the transport boundary too early
- Version-skew handling must preserve safe read access without opening unsafe mutation paths
- CLI coverage can become nominal instead of canonical if new daemon features are allowed to ship renderer-first

## Progress Log

- **PR #16** (squash-commit `49f1116` on `develop`, merged 2026-04-28): Phase 1 — SecureDefaults Bootstrap. Tasks `T-007p-1-1` (SecureDefaults.load + effectiveSettings), `T-007p-1-2` (security.default.override audit emitter), `T-007p-1-3` (bootstrap orchestrator + load-before-bind guard), `T-007p-1-4` (W-007p-1-T1..T5 invariant test suite) delivered. Acceptance criteria green: W-007p-1-T1..T5 (18 cases, 49/49 package tests pass). Plan-doc path amendment landed in same PR (T-007p-1-4 target_path corrected from `test/bootstrap/` to `src/bootstrap/__tests__/` to match repo's universal vitest include glob). BLOCKED-ON-C6 / -C7 / -C9 markers carried forward without premature shape pre-commit. Post-merge polish surfaced: ~30 OBSERVATIONs aggregated (see PR #16 Review Notes; key items: `localhost`/`bindPort`-negative coverage gaps, T-T4 regex-from-loop-var, citation-symmetry across bootstrap files).
- **PR #17** (squash-commit `3d8ef0e` on `develop`, merged 2026-04-29): Phase 2 — Wire Substrate. Tasks `T-007p-2-1` (JSON-RPC 2.0 + LSP Content-Length framing + supervision hooks), `T-007p-2-2` (numeric-error-space ↔ dotted-namespace mapping), `T-007p-2-3` (method-namespace registry with mutating flag), `T-007p-2-4` (DaemonHello/DaemonHelloAck negotiation + mutating-op gate), `T-007p-2-5` (`LocalSubscription<T>` streaming primitive), `T-007p-2-6` (W-007p-2-T1..T11 invariant test suite) delivered. Acceptance criteria green: 129 passed / 1 skipped (Linux-runner Windows-pipe transport) / 1 todo (Tier-4 `transport.unavailable` envelope deferred per BLOCKED-ON-C7) across 7 test files in 2.18s. Plan-doc path amendment landed in same PR (T-007p-2-6 target_path corrected from `test/ipc/` to `src/ipc/__tests__/` to match repo's universal vitest include glob — same defect class as PR #16). BLOCKED-ON-C6 / -C7 markers carried forward across all five touched files with explicit replacement comments at each boundary. Round-trips: `86df812` reclassified `oversized_body` from `-32603 InternalError` to `-32600 InvalidRequest` per Plan-007:268 mapping contract (T-2 ACTIONABLE); `bf74902` folded round-trip-1 — non-idempotent test `close()` helper diagnosed via standalone Node repro as the W-007p-2-T5 5000ms-hang root cause (substrate gateway verified correct, fix landed pre-Phase-C); `3795d1f` round-trip-2 — three Phase-C ACTIONABLE findings (stale comment cleanup, silent-failure-pattern fix in `malformed_header` framing test, outer `expect(caught).toBeInstanceOf(...)` guard at registry.test.ts:387); `66099bf` round-trip-3 (Codex external review on PR head `0907f59`) — three P1/P2 ACTIONABLE findings on `local-ipc-gateway.ts` addressed inline (start() now rolls back `#server`/`#started` on listen failure preventing bootstrap-retry wedge; dispatch validates `id` shape (`string | number | null`) BEFORE handler dispatch per JSON-RPC §4 + I-007-7, malformed ids emit `-32600 Invalid Request` with `id: null` per §5; parseFrame applies the 1 KB header-section cap symmetrically whether or not CRLFCRLF is present, closing a header-bypass DoS surface) + 6 new RT-codex-1 invariant tests covering each fix's contract directly (regex-anchored wedge probe, `vi.fn()` spy asserting handler non-execution, byte-count assertions on header cap). Phase D (PR-scope, full-diff review) returned 0 ACTIONABLE / 3 OBSERVATIONS deferred to a polish PR: O-D-1 Plan-007 §CP-007-3 prose drift (`router.add` vs canonical `router.register`), O-D-2 test-fixture duplication (`passthroughSchema<T>` × 4, `rejectingSchema<T>` × 2 — past rule-of-three on a non-blocked surface), O-D-3 review-process attribution leaked into production source comments (~16 references to "advisor's #N", "orchestrator pre-brief"; rationale prose load-bearing, attribution prefixes are not). CI required multiple pushes — the lint-staged hook runs `eslint --fix` + `tsc -b` but not `prettier --write`, so format drift escapes locally; sealed twice with `0907f59` (PR #17 substrate) and `8e55500` (RT-codex-1 test additions). The repeating-defect pattern is added to the polish-PR scope for a hook-config follow-up (lint-staged should pipe `prettier --write` on staged paths so CI's `prettier --check` becomes a redundancy gate, not a discovery surface).

## Done Checklist

### Tier 1 (Plan-007-Partial)

- [ ] All Tier 1 W-007p-1-T1..T5 + W-007p-2-T1..T11 + I-007-3-T1..T5 tests pass
- [ ] Invariants I-007-1 through I-007-9 enforced and individually tested at Tier 1 scope
- [ ] §Cross-Plan Obligations CP-007-1..5 surface ships verified (CP-007-1 `session.*` handlers + SDK; CP-007-3 `router.register` registry; CP-007-4 `transport/jsonRpcClient.ts` + `transport/types.ts`)
- [ ] BLOCKED-ON-C6 governance pickup tracked: api-payload-contracts.md §Plan-007 declares `protocolVersion` type, `MethodRegistry` shape, method-name format convention, `LocalSubscription<T>` shape; conservative inline shapes replaced with imported types
- [ ] BLOCKED-ON-C7 governance pickup tracked: error-contracts.md JSON-RPC numeric ↔ dotted-namespace mapping landed; `unknown_setting` error envelope authoritative; `transport.unavailable` + `resource.limit_exceeded` envelopes authoritative
- [ ] BLOCKED-ON-C9 governance pickup tracked: Spec-006 §Event Type Summary registers `security.default.override` + `security.update.available`; Plan-006 emitter table lists Plan-007
- [ ] BLOCKED-ON-C6 governance pickup tracked: subscribe streaming-primitive shape reconciled across session.ts:388 / Plan-001:269 / api-payload-contracts.md:535-577; ADR-009 amendment recorded if substrate-level decision required
- [ ] Plan-001 Phase 5's `sessionClient.ts` consumes the transport surface from CP-007-4 without modification (verified via T-007p-3-3)

### Tier 4 (Plan-007-Remainder)

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
- [ ] `SecureDefaults` module lands with all Spec-027-owned rows enforced (2, 3, 4, 7a, 7b, 8, 10) and every override path emits its `security.default.override=*` log event
- [ ] First-run key ceremony verified on Linux, macOS, and Windows (permissions + sentinel + fingerprint display)
- [ ] TLS 1.3-only listener factory verified to reject TLS 1.2 without `LEGACY_TLS12=1` and reject TLS ≤ 1.1 even with the legacy flag
- [ ] Self-update CLI verified against dual-verification (manifest-sig + Sigstore) and anti-rollback/freeze checks on all three platforms
- [ ] First-run-banner content contract verified: every Spec-027-row-10 field renders in stdout text and in `BANNER_FORMAT=json` single-line form
