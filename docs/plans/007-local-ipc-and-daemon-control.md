# Plan-007: Local IPC And Daemon Control

| Field                   | Value                                                                                                                                                                                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**              | `approved`                                                                                                                                                                                                                                                       |
| **NNN**                 | `007`                                                                                                                                                                                                                                                            |
| **Slug**                | `local-ipc-and-daemon-control`                                                                                                                                                                                                                                   |
| **Date**                | `2026-04-14`                                                                                                                                                                                                                                                     |
| **Author(s)**           | `Codex`                                                                                                                                                                                                                                                          |
| **Spec**                | [Spec-007: Local IPC And Daemon Control](../specs/007-local-ipc-and-daemon-control.md)                                                                                                                                                                           |
| **Required ADRs**       | [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md), [ADR-009](../decisions/009-json-rpc-ipc-wire-format.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies**        | None                                                                                                                                                                                                                                                             |
| **Cross-Plan Deps**     | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md)                                                                                                                                                                                        |
| **Owned Spec-027 Rows** | 2, 3, 4, 7a, 7b, 8, 10 (daemon-side secure-default enforcement — see [Spec-027 §Required Behavior](../specs/027-self-host-secure-defaults.md#required-behavior))                                                                                                 |

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

**Override coverage (audit-visible).** Every row with an override path listed in [Spec-027 §Fallback Behavior](../specs/027-self-host-secure-defaults.md#fallback-behavior) emits the override's `security.default.override=*` log event through `secure-defaults-events.ts`. Banner output (row 10) enumerates active overrides on every startup.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define daemon handshake, lifecycle, and subscription contracts in shared packages.
2. Implement `SecureDefaults` configuration + enforcement layer (`secure-defaults.ts`, `secure-defaults-events.ts`) covering Spec-027 rows 2, 3, 4, 7a, 8, 10; wire it as the first step of daemon bootstrap before any listener binds.
3. Implement daemon TLS 1.3-only listener factory (`tls-surface.ts`) and first-run key ceremony (`first-run-keys.ts`).
4. Implement update-notify poller (`update-notify.ts`, row 7a) and CLI self-update dual-verification command (`apps/cli/src/commands/self-update.ts`, row 7b).
5. Implement OS-local IPC gateway and protocol-version negotiation in the Local Runtime Daemon (consuming the `SecureDefaults.effectiveSettings` view for bind address and TLS mode).
6. Implement the CLI on top of the same client SDK and daemon contract rather than embedding daemon logic directly.
7. Implement desktop-shell daemon supervision and actionable startup or reconnect status surfaces on the same stabilized contract.

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
