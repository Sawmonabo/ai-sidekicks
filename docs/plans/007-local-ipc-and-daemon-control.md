# Plan-007: Local IPC And Daemon Control

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**              | `approved`                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **NNN**                 | `007`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Slug**                | `local-ipc-and-daemon-control`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Date**                | `2026-04-14`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Author(s)**           | `Codex`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Spec**                | [Spec-007: Local IPC And Daemon Control](../specs/007-local-ipc-and-daemon-control.md)                                                                                                                                                                                                                                                                                                                                                                                               |
| **Required ADRs**       | [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md), [ADR-009](../decisions/009-json-rpc-ipc-wire-format.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md)                                                                                                                                                                                                                     |
| **Dependencies**        | None upstream. **Tier 1 / Tier 4 split** per [cross-plan-dependencies.md §5 Plan-007 Substrate-vs-Namespace Carve-Out](../architecture/cross-plan-dependencies.md#plan-007-substrate-vs-namespace-carve-out-tier-1--tier-4) — Plan-007-partial (Spec-007 §Wire Format substrate + `session.*` namespace + SDK Zod layer) ships at Tier 1 to unblock [Plan-001](./001-shared-session-core.md) PR #5; Plan-007-remainder ships at Tier 4. See §Execution Windows (V1 Carve-Out) below. |
| **Cross-Plan Deps**     | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md)                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Owned Spec-027 Rows** | 2, 3, 4, 7a, 7b, 8, 10 (daemon-side secure-default enforcement — see [Spec-027 §Required Behavior](../specs/027-self-host-secure-defaults.md#required-behavior))                                                                                                                                                                                                                                                                                                                     |

## Execution Windows (V1 Carve-Out)

Plan-007 ships in two windows — a **Tier 1 partial-deliverable** (substrate + `session.*` namespace) that unblocks [Plan-001](./001-shared-session-core.md) PR #5, and a **Tier 4 remainder** that completes the daemon control surface. The split is documented authoritatively in [cross-plan-dependencies.md §5 Plan-007 Substrate-vs-Namespace Carve-Out](../architecture/cross-plan-dependencies.md#plan-007-substrate-vs-namespace-carve-out-tier-1--tier-4); this section is the plan-side restatement so engineers reading Plan-007 in isolation see the split.

### Tier 1 — Plan-007-Partial (substrate + `session.*` namespace)

Lands alongside Plan-001 to unblock Plan-001 PR #5. Scope:

- **Spec-007 §Wire Format substrate** — `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts` and `packages/runtime-daemon/src/ipc/protocol-negotiation.ts` implementing JSON-RPC 2.0 with LSP-style Content-Length framing (`Content-Length: <byte-count>\r\n\r\n`), 1MB max-message-size, protocol-version negotiation, the typed error model, and supervision hooks. OS-local transport (Unix domain socket / Windows named pipe) is the default; loopback fallback is gated.
- **Spec-027 daemon-side bind-time substrate** — `packages/runtime-daemon/src/bootstrap/secure-defaults.ts` and `packages/runtime-daemon/src/bootstrap/secure-defaults-events.ts` implementing `SecureDefaults.load()` + `effectiveSettings()` + fail-closed enforcement, with validation scope limited to the bind paths Tier 1 exposes (loopback OS-local socket only). Honors §Secure Defaults > Invariants (load-before-bind and fail-closed) at the Tier 1 bind surface; Plan-007-remainder extends the validation surface at Tier 4 alongside the additional bind paths (HTTP, non-loopback, TLS).
- **`session.*` JSON-RPC method namespace only** — typed handlers for `SessionCreate`, `SessionRead`, `SessionJoin`, `SessionSubscribe` (the Plan-001 vertical-slice contracts). No `run.*`, `repo.*`, `artifact.*`, `settings.*`, or `daemon.*` namespaces in this window.
- **SDK Zod layer (~500–1000 LOC per [Spec-007 §Wire Format](../specs/007-local-ipc-and-daemon-control.md#wire-format))** — the typed wrapper in `packages/client-sdk/` exposing the daemon transport for `sessionClient`. Following the MCP TypeScript SDK pattern.

### Tier 4 — Plan-007-Remainder (other namespaces + supervision + Spec-027)

Lands at Plan-007's original Tier 4 slot, co-tier with Plan-005 (runtime bindings) and Plan-006 (event taxonomy) — all three are gated only on Tier 1 completion per [cross-plan-dependencies.md §5 Canonical Build Order](../architecture/cross-plan-dependencies.md#5-canonical-build-order). Scope:

- The four other JSON-RPC method namespaces — `run.*`, `repo.*`, `artifact.*`, `settings.*`, `daemon.*` — extending the substrate's namespace registry without re-implementing the wire layer.
- The Spec-027 secure-defaults bootstrap surface owned by Plan-007 widens at Tier 4 alongside the additional bind paths — `tls-surface.ts` (row 8 — only load-bearing once a non-loopback / TLS bind enters), `first-run-keys.ts` (row 3 — daemon master key generation; key custody is Plan-022's at Tier 5), `update-notify.ts` (row 7a — periodic poller, not a bind-time gate), and the CLI `self-update` dual-verification command (row 7b — out-of-process). The Tier 1 partial already ships the bind-time `SecureDefaults` validation surface (`secure-defaults.ts` + `secure-defaults-events.ts`) scoped to the loopback OS-local socket bind path it exposes, so the §Secure Defaults > Invariants block (load-before-bind + fail-closed) holds at every execution window.
- The CLI delivery track (`apps/cli/`) and desktop-shell daemon supervision (`apps/desktop/shell/src/daemon-supervision/`, `apps/desktop/renderer/src/daemon-status/`).

### Substrate-vs-Namespace Decomposition Rule (Methodology)

**Rule:** Cross-cutting infrastructure plans MAY be split into a Tier-N substrate-deliverable + a Tier-M namespace-deliverable when (a) the substrate is single-owned and load-bearing for an earlier-tier consumer, AND (b) the namespaces have natural cohesion with their owning plans. Substrate ships first; namespaces ship with their owning plans.

**Rationale.** Spec-007 conflates two concerns — the cross-cutting _transport substrate_ (correctly single-owned by Plan-007: only one set of framing, version-negotiation, and error semantics may exist in the system) and the domain-specific _method namespaces_ (which cohere with their owning plans: `session.*` belongs with session core, `run.*` with run orchestration, etc.). Without a carve-out, Plan-001 PR #5 either (a) inherits an undeclared forward dependency on Plan-007 at Tier 4, breaking build-order discipline, or (b) duplicates the wire substrate in Plan-001, breaking single-ownership of the transport layer. The carve-out preserves both invariants by isolating the substrate at the consumer's tier while leaving namespace implementations at their natural plan boundaries.

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

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

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

| Spec-027 Row                                                 | Daemon-Side Behavior                                                                                                                                                                                                                                                                                                                                                                                                                | `SecureDefaults` Enforcement Point                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 2 — Refuse to start without encryption on non-loopback bind  | Config parser rejects `<non-loopback bind> + <no TLS>` combination with non-zero exit; `--insecure` override emits loud banner + `security.default.override=insecure_bind` log event                                                                                                                                                                                                                                                | `secure-defaults.ts` + `secure-defaults-events.ts`                                     |
| 3 — Auto-generated strong secrets on first run (daemon keys) | Daemon master key (Spec-022) + session-signing key generated via `crypto.randomBytes(N ≥ 32)` on first run; persisted `0600` (Unix) / ACL (Windows); fingerprints printed to stdout AND on-disk file header comment (`age-keygen` pattern); `./data/trust/first-run.complete` sentinel required before subsequent boots                                                                                                             | `first-run-keys.ts`                                                                    |
| 4 — Loopback bind by default (daemon)                        | `DAEMON_BIND` defaults to `127.0.0.1`; daemon local-IPC socket and daemon HTTP listener both loopback-only by default; `DAEMON_BIND=0.0.0.0` permitted only in conjunction with TLS (row 2 interaction)                                                                                                                                                                                                                             | `secure-defaults.ts`                                                                   |
| 7a — Auto-update notify-by-default (daemon)                  | Daemon polls GitHub Releases (or operator-configured feed) on a cadence owned by this plan; newer release → CLI invocation prompt + first-run-banner line + `security.update.available` log event; daemon MUST NOT self-swap while IPC is live                                                                                                                                                                                      | `update-notify.ts`                                                                     |
| 7b — Opt-in self-update (CLI)                                | `ai-sidekicks self-update` fetches manifest + Sigstore bundle; verifies **both** Ed25519 manifest signature AND Sigstore attestation; passing either alone is insufficient; manifest anti-rollback/freeze via `version` monotonic + `previous_manifest_hash` + `next_signing_keys` + `expires_at`; atomic swap + re-exec with platform-specific rules                                                                               | `apps/cli/src/commands/self-update.ts`                                                 |
| 8 — TLS 1.3 minimum                                          | All daemon TLS surfaces (daemon HTTPS, WebSocket Secure) negotiate TLS 1.3 only via `{minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3'}` on `tls.createServer` / `https.createServer`; TLS ≤ 1.1 rejected outright (RFC 8996); `--legacy-tls12` override permits 1.2 with loud banner + `security.default.override=legacy_tls12` log event                                                                                              | `tls-surface.ts`                                                                       |
| 10 — Loud first-run banner (daemon content)                  | On every daemon process start, single-screen stdout banner enumerates: TLS mode + fingerprint (if self-signed/internal-CA), effective bind addresses, backup destination + cadence, admin-token file path, update channel + mode, any active `security.default.override=*` rows; format owned by Plan-026, content provided by `SecureDefaults.effectiveSettings` view; `BANNER_FORMAT=json` emits same payload as single JSON line | `secure-defaults.ts` exposes content contract; `first-run-banner` consumer in Plan-026 |

**Invariants.**

- `SecureDefaults.load(config)` MUST run **before** any daemon listener binds. Attempting to bind a listener before `SecureDefaults.load` completes is a programmer error and MUST throw.
- `SecureDefaults.load` MUST fail closed on invalid or downgraded security settings — there is no "best-effort partial start" path.
- `SecureDefaults.effectiveSettings` exposes only non-secret typed values (bind addresses, TLS mode, override flags, fingerprint paths). Raw keys and secrets are NEVER exposed through this view.
- Every override emits exactly one `security.default.override=<behavior>` log event per startup (not per request, not per event batch).
- These invariants apply to whatever bind paths the daemon exposes at the current execution window. Plan-007-partial (Tier 1) ships a minimal bind surface (loopback OS-local socket only) and a `SecureDefaults` validation surface scoped accordingly; Plan-007-remainder (Tier 4) extends both as additional bind paths (HTTP, non-loopback, TLS) are introduced. The invariants hold at every window — the validation surface widens as the bind surface widens. At Tier 1, the daemon MUST refuse settings keys outside the loopback-bind validation scope (e.g., TLS configuration, non-loopback host, first-run-keys policy) with an `unknown_setting` validation error per the fail-closed invariant — silent drop is forbidden. The validation surface widens at Tier 4 to accept those keys; until then, their presence in operator config is a fail-closed condition.

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

### PR #1: Wire Substrate

**Goal:** Spec-007 §Wire Format substrate ships behind passing handshake + transport tests. No `session.*` handlers yet — this PR delivers the JSON-RPC + framing layer only.

**Precondition:** None at the plan level. Tier 1 entry point.

- `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts` — JSON-RPC 2.0 dispatcher with LSP-style Content-Length framing (`Content-Length: <byte-count>\r\n\r\n`), 1MB max-message-size enforcement, typed error model (`packages/contracts/src/error.ts` shapes), supervision hooks, and OS-local socket / Windows named-pipe transport (default) with gated loopback fallback per [Spec-007 §Wire Format](../specs/007-local-ipc-and-daemon-control.md#wire-format) and [Spec-007 §Fallback Behavior](../specs/007-local-ipc-and-daemon-control.md#fallback-behavior).
- `packages/runtime-daemon/src/ipc/protocol-negotiation.ts` — `DaemonHello` / `DaemonHelloAck` exchange, protocol-version pinning, mutating-operation gate when versions are incompatible per [Spec-007 §Required Behavior](../specs/007-local-ipc-and-daemon-control.md#required-behavior).
- Tests: handshake + version-negotiation compatibility tests; transport tests for Unix socket, named pipe, and gated loopback fallback (per §Test And Verification Plan above).

### PR #2: SecureDefaults Bootstrap (loopback-bind validation only)

**Goal:** Spec-027 daemon-side bind-time substrate ships at the validation surface Tier 1 actually exposes. `SecureDefaults.load` runs before any listener binds; fail-closed enforcement is active; Tier-4-scope settings keys (TLS, non-loopback, first-run-keys) are refused with `unknown_setting`.

**Precondition:** PR #1 merged (the wire substrate consumes `SecureDefaults.effectiveSettings` for the loopback OS-local bind path).

- `packages/runtime-daemon/src/bootstrap/secure-defaults.ts` — `SecureDefaults.load(config)` + `effectiveSettings()` API, validation scope limited to the loopback OS-local socket bind path Tier 1 exposes (rows 4 + 10 of the §Secure Defaults table above).
- `packages/runtime-daemon/src/bootstrap/secure-defaults-events.ts` — `security.default.override=*` audit event emitter (single emit per startup, not per request).
- Wire `SecureDefaults.load` as the first step of daemon bootstrap, before `local-ipc-gateway` opens its listener (per §Invariants above).
- Tests: `SecureDefaults.load` invariant tests (load-before-bind enforcement throws on out-of-order; fail-closed on invalid config; `effectiveSettings` never exposes secrets); negative-path test that Tier-4-scope settings keys are refused with `unknown_setting` error.

### PR #3: `session.*` Handlers + SDK Zod Layer

**Goal:** `session.*` JSON-RPC namespace ships end-to-end behind passing handler tests; client SDK Zod wrapper exposes the daemon transport with typed schemas. Plan-001 PR #5 unblocks on this PR's merge (in conjunction with Plan-008 bootstrap PR #1).

**Precondition:** PR #1 + PR #2 merged.

- `session.*` namespace handlers in the daemon — typed JSON-RPC handlers for `SessionCreate`, `SessionRead`, `SessionJoin`, `SessionSubscribe` (the Plan-001 vertical-slice contracts already in `packages/contracts/src/session.ts`). No `run.*` / `repo.*` / `artifact.*` / `settings.*` / `daemon.*` handlers — those ship in Plan-007-remainder at Tier 4.
- `packages/client-sdk/` — Zod-wrapped typed SDK (~500–1000 LOC per [Spec-007 §Wire Format](../specs/007-local-ipc-and-daemon-control.md#wire-format)) following the MCP TypeScript SDK pattern. Exposes `session.*` methods over the daemon transport.
- Tests: `session.*` handler integration tests (create / read / join / subscribe round-trip through the wire substrate); SDK Zod-validation tests covering malformed-payload rejection.

After PR #3 merges (and Plan-008 bootstrap PR #1 also merges), [Plan-001 PR #5](./001-shared-session-core.md#pr-5--client-sdk-and-desktop-bootstrap) consumer can begin.

## Parallelization Notes

- IPC contract work and shell supervision scaffolding can proceed in parallel once handshake semantics are fixed.
- CLI work can begin as soon as the shared client SDK contract is stable and should finish before renderer-specific daemon control surfaces.

## Test And Verification Plan

- Handshake and version-negotiation compatibility tests
- Transport tests for Unix socket, named pipe, and gated loopback fallback behavior
- Manual verification that desktop renderer and CLI reach the same daemon semantics through the same typed SDK
- **Secure-defaults negative-path tests (Spec-027 rows 2, 3, 4, 7a, 7b, 8, 10):**
  - Row 2: daemon refuses to start when `<non-loopback bind> + <no TLS>`; `--insecure` override boots with banner + `security.default.override=insecure_bind` event emitted exactly once.
  - Row 3: first-run ceremony generates keys with `N ≥ 32` bytes of entropy (test the entropy source); persisted-file permissions verified (`0600` Unix; ACL Windows); fingerprint appears in both stdout and on-disk file header; sentinel absence blocks subsequent starts with actionable error.
  - Row 4: daemon defaults to `127.0.0.1`; `DAEMON_BIND=0.0.0.0` without TLS fails at config-parse time; `DAEMON_BIND=0.0.0.0` with TLS boots cleanly.
  - Row 7a: update poller emits `security.update.available` event when newer release detected; daemon refuses self-swap while IPC socket has active clients.
  - Row 7b: self-update CLI rejects manifest where only Ed25519 passes but Sigstore fails; rejects manifest where only Sigstore passes but Ed25519 fails; rejects manifest with `version <= last_seen_version`; rejects manifest with `now > expires_at`; atomic swap + re-exec verified on Linux, macOS, Windows.
  - Row 8: TLS surface negotiates 1.3 only — test rejects 1.2 handshake outright unless `LEGACY_TLS12=1` + banner emitted; test rejects 1.1 and 1.0 even with legacy flag (RFC 8996 floor).
  - Row 10: banner output enumerates TLS mode, bind addresses, backup destination, admin-token file path, update mode, active overrides on every startup; `BANNER_FORMAT=json` produces single-JSON-line equivalent.
- `SecureDefaults.load` invariant tests: attempting to bind a listener before `SecureDefaults.load` completes throws; invalid config produces typed error with actionable message; `effectiveSettings` never exposes secrets.

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

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
- [ ] `SecureDefaults` module lands with all Spec-027-owned rows enforced (2, 3, 4, 7a, 7b, 8, 10) and every override path emits its `security.default.override=*` log event
- [ ] First-run key ceremony verified on Linux, macOS, and Windows (permissions + sentinel + fingerprint display)
- [ ] TLS 1.3-only listener factory verified to reject TLS 1.2 without `LEGACY_TLS12=1` and reject TLS ≤ 1.1 even with the legacy flag
- [ ] Self-update CLI verified against dual-verification (manifest-sig + Sigstore) and anti-rollback/freeze checks on all three platforms
- [ ] First-run-banner content contract verified: every Spec-027-row-10 field renders in stdout text and in `BANNER_FORMAT=json` single-line form
