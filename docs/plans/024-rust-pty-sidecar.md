# Plan-024: Rust PTY Sidecar

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `024` |
| **Slug** | `rust-pty-sidecar` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude Opus 4.7` |
| **Spec** | _(none; ADR-driven per ADR-019)_ |
| **Required ADRs** | [ADR-019: Windows V1 Tier and Rust PTY Sidecar Strategy](../decisions/019-windows-v1-tier-and-pty-sidecar.md), [ADR-009: JSON-RPC IPC Wire Format](../decisions/009-json-rpc-ipc-wire-format.md) |
| **Dependencies** | `None` (upstream of Plan-005; sidecar binary and `PtyHost` contract must land before Plan-005 authors runtime-binding consumers) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Ship a Rust PTY sidecar binary implementing the `PtyHost` contract, distributed per-platform via npm `optionalDependencies`, signed for Windows and macOS per each platform's trust-chain requirements, and wired as the **Windows-primary** PTY backend with `node-pty` as the macOS/Linux primary and the Windows fallback. This closes the structural fix named by ADR-019 against the `node-pty` ConPTY bug cluster ([openai/codex#13973](https://github.com/openai/codex/issues/13973), [microsoft/node-pty#904](https://github.com/microsoft/node-pty/issues/904), [microsoft/node-pty#887](https://github.com/microsoft/node-pty/issues/887), [microsoft/node-pty#894](https://github.com/microsoft/node-pty/issues/894)) before Plan-005 (runtime bindings) consumes `PtyHost`.

## Scope

- Rust `sidecar-rust-pty/` crate built on `portable-pty ≥ 0.9.0` (WezTerm), pinned via `Cargo.toml` + `Cargo.lock` committed to the repo
- LSP-style Content-Length stdio framing (ADR-009 parity), JSON control channel + length-prefixed binary frames for stdout/stderr
- Five platform packages (`@ai-sidekicks/pty-sidecar-{win32-x64,darwin-arm64,darwin-x64,linux-x64,linux-arm64}`) + umbrella `@ai-sidekicks/pty-sidecar` meta-package with `optionalDependencies` + `os`/`cpu` filters, matching the [esbuild platform-package pattern](https://www.npmjs.com/package/esbuild) (26 `@esbuild/*` packages as of 0.28.0 / 2026-04-02)
- `PtyHost` TypeScript contract in `packages/contracts/` — two implementations (`RustSidecarPtyHost`, `NodePtyHost`) + a `PtyHostSelector` that picks Windows-primary / Unix-primary defaults with an env-var override
- Daemon-side sidecar supervision: spawn, health check, respawn on crash, fall back to `NodePtyHost` if the sidecar binary is not resolvable
- **Windows signing** via two parallel procurement tracks (gated by geographical eligibility, not a primary/fallback relationship)
- **macOS signing** via Apple Developer ID Application codesign + `xcrun notarytool` + `xcrun stapler`, on the same certificate identity as Spec-023's Electron shell (reuse of identity; net-new operation since npm-delivered Mach-O binaries ship outside the .app bundle and therefore are NOT covered by the shell's notarization ticket)
- **Linux**: no universal signing model; ship the ELF stripped, publish the hash alongside the npm package, rely on npm registry integrity for distribution trust
- CI cross-compile matrix using `cargo-zigbuild v0.22.2` (2026-04-16), with native `macos-14` / `macos-15` arm64 runners for `darwin-arm64` to side-step [cargo-zigbuild#316](https://github.com/rust-cross/cargo-zigbuild/issues/316) (aarch64-apple-darwin iconv linker regression with `zstd-sys` dependencies under Rust ≥ 1.82)

## Non-Goals

- WezTerm-level terminal-emulator features — the sidecar muxes PTYs, it does not render UI
- Sidecar-layer TLS or authentication — the sidecar talks stdio only, parent-child, inheriting the daemon's process boundary
- Upgrading the `node-pty` fallback to `useConptyDll: true` — deferred per ADR-019 Tripwire 3 until [microsoft/node-pty#894](https://github.com/microsoft/node-pty/issues/894) closes
- macOS or Linux sidecar as primary — those platforms use in-process `node-pty` by default per ADR-019; the sidecar is still published there as an env-var-selectable override and as insurance against future platform-specific `node-pty` regressions
- Runtime signature verification of the sidecar binary by the daemon — deferred per esbuild / napi-rs precedent; distribution integrity rests on npm registry TUF + lockfile; OS-level trust chains (Gatekeeper, SmartScreen) enforce signature at spawn, which is the right layer for that check. V1.1 may add optional daemon-side pubkey verification as defense-in-depth hardening — especially on Linux where no OS-level spawn check exists (see §Risks And Blockers)

## Preconditions

- [x] ADR-019 accepted (Windows V1 GA + Rust PTY sidecar strategy)
- [x] ADR-009 accepted (JSON-RPC + Content-Length IPC wire format — sidecar reuses the framing)
- [ ] Apple Developer Program enrollment + Developer ID Application certificate procured (same certificate Spec-023 uses for the Electron shell — procurement inherits; usage is additive)
- [ ] Windows signing procurement track selected per publishing-entity eligibility (see §Windows Signing — Two Parallel Tracks)
- [ ] Azure Artifact Signing **eligibility decision confirmed** for the publishing entity (Azure Artifact Signing FAQ — see [eligibility reference](https://learn.microsoft.com/en-us/azure/artifact-signing/faq))
- [ ] Plan-007 (local IPC) and Plan-001 (shared session core) on track for Tier 1 completion — `PtyHost` contract lands in `packages/contracts/` ahead of Plan-005's consumption

## Target Areas

- `packages/sidecar-rust-pty/Cargo.toml` — Rust crate manifest, pinned `portable-pty ≥ 0.9.0`, MSRV `rust-version = "1.85"`
- `packages/sidecar-rust-pty/Cargo.lock` — committed, deterministic builds
- `packages/sidecar-rust-pty/src/main.rs` — stdio Content-Length loop, dispatcher
- `packages/sidecar-rust-pty/src/protocol.rs` — serde-bindings for `SpawnRequest`, `ResizeRequest`, `WriteRequest`, `KillRequest`, `ExitCodeNotification`, `PingRequest`/`Response`, `DataFrame` (binary-carrying envelope)
- `packages/sidecar-rust-pty/src/pty_session.rs` — per-session `portable-pty` holder, stdout/stderr pump, exit-code latch
- `packages/contracts/src/pty-host.ts` — `PtyHost` interface consumed by Plan-005 (runtime bindings) and Plan-004 (queue/intervention)
- `packages/contracts/src/pty-host-protocol.ts` — mirror of Rust protocol types for TS consumers
- `packages/runtime-daemon/src/pty/rust-sidecar-pty-host.ts` — spawn sidecar via `require.resolve('@ai-sidekicks/pty-sidecar-${platform}-${arch}/bin/sidecar')`, Content-Length framing, crash-respawn supervision
- `packages/runtime-daemon/src/pty/node-pty-host.ts` — in-process `node-pty` fallback implementation (Windows fallback + macOS/Linux primary)
- `packages/runtime-daemon/src/pty/pty-host-selector.ts` — platform-default picker + env-var override (`AIS_PTY_BACKEND=rust-sidecar|node-pty`)
- `.github/workflows/sidecar-build.yml` — 5-target cross-compile matrix + signing stages
- `tools/publish-sidecar.mjs` — publish platform packages + umbrella meta-package

## Data And Storage Changes

None. The sidecar is stateless across restarts — per-session PTY handles live only in-memory. Session state persists via the daemon's own tables (owned by Plan-001 / Plan-004), never by the sidecar.

## API And Transport Changes

- **New `PtyHost` contract** (TypeScript, `packages/contracts/src/pty-host.ts`): methods `spawn(spec)`, `resize(sessionId, rows, cols)`, `write(sessionId, bytes)`, `kill(sessionId, signal)`, `close(sessionId)`; event streams `onData(sessionId, chunk)`, `onExit(sessionId, exitCode)`. Implementations: `RustSidecarPtyHost`, `NodePtyHost`.
- **New stdio wire protocol** (daemon ↔ sidecar): LSP-style `Content-Length: N\r\n\r\n<body>` framing (identical to ADR-009). JSON envelope carries a `kind` discriminant and either a control message or a binary-frame descriptor. Binary stdout/stderr chunks ride their own `DataFrame { session_id, stream: "stdout"|"stderr", bytes: base64 }` message so the JSON framer stays a single path (trade-off accepted: base64 overhead vs second framer — single framer wins for V1 simplicity; revisit if throughput becomes a constraint per ADR-019 Assumption 4).

## Implementation Steps

1. **Scaffold Rust crate.** Create `packages/sidecar-rust-pty/` with `Cargo.toml` declaring `portable-pty = "0.9"`, `serde`, `serde_json`, `tokio` (current LTS), `clap`. Set `rust-version = "1.85"` and commit `Cargo.lock`.
2. **Implement Content-Length framing.** Port the ADR-009 framing semantics into Rust (`src/framing.rs`): read `Content-Length: N\r\n\r\n`, read exactly N bytes, hand off to dispatcher; write is the inverse. Unit-test the round-trip on a byte-level fixture.
3. **Define protocol types.** In `src/protocol.rs`, declare serde structs for `SpawnRequest` (command, args, env, cwd, rows, cols), `SpawnResponse` (session_id), `ResizeRequest`, `WriteRequest`, `KillRequest`, `ExitCodeNotification`, `PingRequest` / `PingResponse`, `DataFrame`. Mirror these types in `packages/contracts/src/pty-host-protocol.ts` so TS and Rust agree by hand-authored parity (no code-gen in V1 — trade-off accepted: two-sided hand edit vs adding a schema compiler; single schema compiler deferred to post-V1).
4. **Implement per-session PTY holder.** In `src/pty_session.rs`, wrap `portable_pty::PtyPair` keyed by an internally-minted `session_id: String`. Spawn stdout/stderr reader tasks that chunk (e.g., 8 KiB) and emit `DataFrame` messages with a monotonically-increasing sequence number.
5. **Wire exit-code capture.** Await the child-process waitable for each session; on exit, emit `ExitCodeNotification { session_id, exit_code, signal_code? }` and drop the `PtyPair`.
6. **Define `PtyHost` interface.** Author `packages/contracts/src/pty-host.ts` from the method list in §API And Transport Changes; export type-only. Plan-005 and Plan-004 will import this; both are downstream.
7. **Implement `RustSidecarPtyHost`.** In `packages/runtime-daemon/src/pty/rust-sidecar-pty-host.ts`, resolve the platform package (`require.resolve('@ai-sidekicks/pty-sidecar-${platform}-${arch}/bin/sidecar')`), spawn it as a child process with `stdio: ['pipe', 'pipe', 'inherit']`, wire Content-Length framing on stdin/stdout, and expose the `PtyHost` contract. Supervise with crash-respawn (exponential backoff, cap 5 failures per 60 s, then surface `PtyBackendUnavailable`).
8. **Implement `NodePtyHost` fallback.** In `packages/runtime-daemon/src/pty/node-pty-host.ts`, in-process `node-pty` wrapper against the same `PtyHost` contract. Used as **macOS/Linux primary** and as **Windows fallback** when the sidecar binary is not resolvable.
9. **Wire `PtyHostSelector`.** In `packages/runtime-daemon/src/pty/pty-host-selector.ts`:
   - Default on `win32`: `RustSidecarPtyHost`, falling back to `NodePtyHost` if the sidecar binary is not resolvable (log a loud warning; this is ADR-019 Failure Mode "Sidecar binary missing on user machine").
   - Default on `darwin` / `linux`: `NodePtyHost`.
   - Env-var override `AIS_PTY_BACKEND=rust-sidecar` forces sidecar selection on all platforms (and, on macOS/Linux, requires the optional sidecar package to have been installed; fails with a clear error otherwise).
10. **CI cross-compile workflow.** Author `.github/workflows/sidecar-build.yml` with a 5-target matrix:
    - `windows-latest` builds `x86_64-pc-windows-msvc` (native toolchain, no zigbuild needed)
    - `macos-14` builds `aarch64-apple-darwin` **natively** (GitHub Actions M-series runner; side-steps [cargo-zigbuild#316](https://github.com/rust-cross/cargo-zigbuild/issues/316) aarch64-apple-darwin iconv linker regression with `zstd-sys` transitive deps under Rust ≥ 1.82)
    - `macos-14` (or `macos-13`) builds `x86_64-apple-darwin` via `cargo-zigbuild v0.22.2` (Intel target still supported; zigbuild is healthier than the stale `cross-rs/cross v0.2.5` — last release 2024-02-04, 2+ years stale as of 2026-04-17)
    - `ubuntu-latest` builds `x86_64-unknown-linux-gnu` via `cargo-zigbuild v0.22.2`
    - `ubuntu-24.04-arm` (or `ubuntu-latest` + zigbuild) builds `aarch64-unknown-linux-gnu`
11. **Windows signing stage — two parallel tracks** (see §Windows Signing — Two Parallel Tracks below for the procurement decision). Whichever track applies, use the **same signing identity as the Electron shell per ADR-019 §Decision item 8** so SmartScreen reputation pools across the app and sidecar rather than splitting.
12. **macOS signing stage.** For each of `darwin-arm64` and `darwin-x64`:
    1. `codesign --timestamp --options runtime --sign "Developer ID Application: <org name> (<team id>)" sidecar` — the hardened-runtime `--options runtime` flag is mandatory for notarization acceptance.
    2. Zip and submit to notarization: `ditto -c -k --keepParent sidecar sidecar.zip && xcrun notarytool submit sidecar.zip --apple-id <id> --team-id <team> --password <app-specific-pwd> --wait`. Use `xcrun notarytool` — `altool` has been deprecated since 2023-11-01 per Spec-023 §macOS and MUST NOT be used.
    3. Staple: `xcrun stapler staple sidecar` so the notarization ticket rides with the binary (required for offline first-launch).
    4. **Queue-delay mitigation.** Apple's notarization queue has shown 16+ hour delays in February 2026 and later per [Apple Developer Forums thread 813441](https://developer.apple.com/forums/thread/813441) (also cited by Spec-023 §macOS Operational risk). The release pipeline MUST implement timeout + retry rather than synchronously blocking on `notarytool --wait`. Recommended shape: submit async, poll every 5 minutes for up to 24 hours, fail the release job (not the build) on hard timeout so the binary can be re-submitted without rebuilding.
    5. **Identity inheritance note.** This uses the **same Apple Developer ID Application certificate** as the Electron shell (Spec-023 §macOS). The identity inherits; the codesign + notarize operation is net-new per this plan because npm-delivered Mach-O binaries ship outside of the shell's `.app` bundle — Gatekeeper enforces `codesign --options runtime` + notarization on first spawn of any standalone Mach-O distributed outside a signed/notarized bundle. The shell's notarization ticket does NOT cover the npm-installed sidecar.
13. **Linux packaging.** `strip` the ELF, publish unsigned. No Gatekeeper / SmartScreen-equivalent exists for an npm-distributed Linux binary; trust rests on npm registry integrity + lockfile pinning. Record the SHA-256 of each published artifact in the package's `README.md` as an out-of-band integrity check.
14. **Publish script.** `tools/publish-sidecar.mjs` publishes the five `@ai-sidekicks/pty-sidecar-<platform>-<arch>` packages (each containing one `bin/sidecar` binary + `package.json` with `os` / `cpu` / `bin` fields) plus the umbrella `@ai-sidekicks/pty-sidecar` package, which declares the five as `optionalDependencies`. Exactly one optional dep installs per user machine per the `os` / `cpu` gates — identical shape to esbuild 0.28.0's 26-package fan-out and to napi-rs v3's pattern (which additionally offers a WASM fallback; out of scope for V1 sidecar).
15. **Daemon consumer wire-up.** Import the umbrella package from `packages/runtime-daemon/package.json`. Resolution in `RustSidecarPtyHost` via `require.resolve('@ai-sidekicks/pty-sidecar-<platform>-<arch>/bin/sidecar')` matches the esbuild lookup pattern.

## Windows Signing — Two Parallel Tracks

Per [Azure Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq) (confirmed in research on 2026-04-17): Public Trust is available to organizations in USA, Canada, EU, and UK and to individual developers in USA and Canada only. Outside those geographies, Public Trust via Azure Artifact Signing is not available.

This plan treats the two signing paths as **parallel tracks selected by the publishing entity's procurement eligibility**, not as a primary/fallback pair. Select one and stick with it; do not mix per-release.

### Track A — Azure Artifact Signing (eligible geographies)

- Applicable to organizations in USA / Canada / EU / UK and individuals in USA / Canada.
- **Product identity:** Renamed from "Azure Trusted Signing" to **"Azure Artifact Signing"**; [GA on 2026-01-12](https://techcommunity.microsoft.com/blog/microsoft-security-blog/simplifying-code-signing-for-windows-apps-artifact-signing-ga/4482789).
- **SKU:** Basic — $9.99/month, 5,000 signatures, 1 certificate profile, FIPS 140-2 Level 3 HSM-backed, zero-touch cert lifecycle. No hardware token. Chains to a CA in the Microsoft Trusted Root Program (SmartScreen-friendly).
- **Does NOT issue EV certificates.** If publishing requires EV chain (e.g., for instant SmartScreen reputation), Track A is insufficient and Track B applies instead or in addition.
- **Integration:** [`Azure/artifact-signing-action`](https://github.com/Azure/artifact-signing-action) GitHub Action, pinned to `@v1.2.0` (published 2026-03-23). The repository was renamed from `Azure/trusted-signing-action` alongside the product rename; GitHub auto-redirects the old path, but new workflow references should use the new name. Works end-to-end in a GitHub-hosted runner; no self-hosted secure enclave needed.
- **Business-history threshold not in primary-source FAQ.** Research on 2026-04-17 found no specific business-history threshold enumerated in the [Azure Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq). Public Trust eligibility is geo-gated as above and requires passing Microsoft's standard verification; the exact business-history requirement (if any) is **not asserted in this plan**. Confirm exact criteria with Microsoft at procurement time.

### Track B — EV Code-Signing Certificate (ineligible geographies or EV-required distribution)

- Applicable everywhere else, and also where Track A is available but EV chain is required.
- **Vendors:** DigiCert, Sectigo, SSL.com. Typical OV pricing $300–$700/year; EV pricing $400–$1,200/year per Spec-023 §Windows — note that 2026-01-15 the CA/Browser Forum Ballot CSC-31 capped cert validity at **460 days (~15 months)**, down from 39 months. Annualized cost comparisons vs Track A must use the 15-month renewal cycle.
- **Hardware requirement:** EV signing certs are issued to a FIPS 140-2 Level 2+ hardware token (YubiKey 5 FIPS, Thales SafeNet, etc.). The token must be present during signing; this affects CI design — either a self-hosted runner with the token attached, or a signing service like SignPath / Keyfactor that proxies to the token.
- **Integration:** `signtool.exe sign /fd SHA256 /tr http://<timestamp-server> /td SHA256 /a sidecar.exe`.
- **Identity alignment:** Same EV certificate as the Electron shell per ADR-019 §Decision item 8 (SmartScreen reputation pooling).

## Parallelization Notes

- Rust crate scaffolding (steps 1–5) runs in parallel to TS `PtyHost` interface definition (step 6).
- Daemon-side `RustSidecarPtyHost` + `NodePtyHost` + selector (steps 7–9) all run in parallel once step 6 lands the contract.
- CI infrastructure (step 10) is independent of the code work once steps 1–5 are scaffolded; signing stages (steps 11–12) can be stubbed with `echo "sign skipped"` placeholders until procurement completes.
- Publish script (step 14) blocks on the CI matrix producing green cross-compile artifacts for all 5 targets.
- Signing procurement runs **asynchronously** to code work — it can start before the Rust crate is scaffolded and frequently gates V1 release rather than V1 development.

## Test And Verification Plan

- **Unit tests (Rust):** protocol serde round-trip for every message type; `portable-pty` spawn of `sh -c 'echo hello; exit 0'` (Linux/macOS) and `cmd.exe /c "echo hello"` (Windows) with assertion of stdout capture and exit-code propagation; Content-Length framer edge cases (partial reads, oversized bodies, malformed headers).
- **Unit tests (TypeScript):** `RustSidecarPtyHost` parses multi-chunk Content-Length framing correctly; `PtyHostSelector` falls back to `NodePtyHost` when `require.resolve` throws `MODULE_NOT_FOUND`; env-var override works on all three platforms.
- **Integration tests:** spawn sidecar from a test harness (vitest, per daemon convention); assert bidirectional round-trip on `echo hello`; assert exit-code delivery; assert `kill(SIGTERM)` propagation.
- **CI cross-compile matrix:** all 5 platform targets build green; per-target artifact size budget < 20 MB (portable-pty + serde + tokio; if Tokio proves oversized, fall back to blocking-std in a thread pool — size budget is the forcing function).
- **Windows Codex `/resume` smoke test** (ADR-019 Success Criteria — `≥ 99%` pass-rate over 50 consecutive `windows-latest` CI runs on driver-integration suite).
- **Sidecar spawn latency** p95 ≤ 50 ms per ADR-019 Success Criteria (measured from selector call to `SpawnResponse` receipt).
- **Signed-binary smoke test:** installer pipeline verifies Gatekeeper acceptance on macOS (`spctl --assess --type exec sidecar`) and SmartScreen / Smart App Control on Windows 11 (see Spec-023 §Windows for the reality-check on SmartScreen's reputation-accrual UX).

## Rollout Order

1. Ship the Rust crate + `PtyHost` interface + `NodePtyHost` impl behind a `PtyHostSelector` whose default on all platforms is `NodePtyHost` (no behavioral change).
2. Ship `RustSidecarPtyHost` implementation guarded by `AIS_PTY_BACKEND=rust-sidecar` env-var (opt-in only).
3. Procure signing identities (Apple Developer ID Application cert; Windows signing-track decision + procurement).
4. Publish signed sidecar binaries to npm at pre-release versions (e.g., `0.0.1-rc.N`).
5. Flip `PtyHostSelector` default on Windows to `RustSidecarPtyHost` with `NodePtyHost` as fallback; leave macOS/Linux on `NodePtyHost` primary.
6. Monitor crash rate (target ≤ 0.01 per 1,000 sessions per ADR-019 Success Criteria) and SmartScreen reputation accrual (target: established-publisher status by 2026-12-01 per ADR-019 Success Criteria).

## Rollback Or Fallback

- `PtyHostSelector` default on Windows can flip back to `NodePtyHost` via env-var override without a release.
- Sidecar binary missing at runtime → `RustSidecarPtyHost` throws at construction → selector auto-fallbacks to `NodePtyHost` with a loud warning banner in daemon logs (per ADR-019 Failure Mode "Sidecar binary missing on user machine").
- Sidecar-originated Sev-1 on Windows → env-var override forces `NodePtyHost` for affected users; hotfix release flips the default back; ADR-019 Tripwire 1 evaluates sidecar sunset.

## Risks And Blockers

- **Apple Developer ID cert procurement.** Mitigated by shared-identity reuse with Spec-023 Electron shell signing — if Spec-023 completes procurement first, Plan-024 inherits the cert at zero additional procurement cost.
- **Azure Artifact Signing eligibility denial** for non-US/CA/EU/UK org publishers (or non-US/CA individuals). Mitigated by Track B (EV cert) availability globally; accepted cost is ~$400–$1,200/year at 15-month renewal per Spec-023.
- **[cargo-zigbuild#316](https://github.com/rust-cross/cargo-zigbuild/issues/316)** — aarch64-apple-darwin iconv linker regression under Rust ≥ 1.82 with `zstd-sys` transitive deps. Mitigated by using native `macos-14` / `macos-15` arm64 runners (Apple Silicon runners are GA on GitHub Actions as of 2026), avoiding the cross-compile path for that target entirely.
- **`portable-pty` 0.8.x → 0.9.0 breaking migration** — the crate swapped its serial-port dep from `serial` to `serial2` in the 0.9.0 bump (repo move to `wezterm/wezterm` org on 2025-02-07). Mitigation: start at 0.9.0, never back-port to 0.8.x.
- **`portable-pty` maintainer continuity** — no formal maintainer-handoff statement after the wezterm org repo move; 0.9.0 (2025-02-11) is the current release. Bounded by the fallback path: `PtyHost` selector can pick `NodePtyHost` on any platform if `portable-pty` becomes unmaintained (ADR-019 Assumption 1's "What Breaks If Wrong" path).
- **Apple notarization queue 16+ hour delays** (Spec-023 §macOS, [Apple Developer Forums 813441](https://developer.apple.com/forums/thread/813441)). Mitigated by async submit + poll release-pipeline pattern (step 12.4 above).
- **Linux supply-chain gap — no OS-level signature check at sidecar spawn on Linux.** No Gatekeeper / SmartScreen equivalent exists for npm-distributed ELF binaries. A compromised `@ai-sidekicks/pty-sidecar-linux-*` npm package would execute unchecked. Accepted trade-off matching the esbuild / napi-rs security posture; mitigation rests on npm registry TUF + lockfile pinning + (post-V1) Sigstore provenance attestations at publish. V1.1 may add optional daemon-side pubkey verification per §Non-Goals as defense-in-depth.
- **Azure Artifact Signing business-history threshold uncertainty** — no specific threshold is enumerated in the primary-source [Azure Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq) as of 2026-04-17 research; confirm exact criteria with Microsoft at procurement time.

## Done Checklist

- [ ] Rust crate builds green across all 5 platform targets (`win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`) in CI
- [ ] Content-Length framing + protocol serde round-trip tests pass in Rust and TypeScript
- [ ] `RustSidecarPtyHost` implements the full `PtyHost` contract and passes the shared integration-test suite
- [ ] `NodePtyHost` implements the full `PtyHost` contract and passes the shared integration-test suite on `windows-latest`, `macos-14`, and `ubuntu-latest`
- [ ] Apple Developer ID codesign + `xcrun notarytool` + `xcrun stapler` pipeline green for `darwin-arm64` and `darwin-x64`
- [ ] Windows signing pipeline green per the selected track (Azure Artifact Signing *or* EV cert)
- [ ] 5 platform packages + umbrella `@ai-sidekicks/pty-sidecar` publish to npm with correct `optionalDependencies` + `os` / `cpu` filters
- [ ] `PtyHostSelector` picks `RustSidecarPtyHost` on Windows by default; falls back to `NodePtyHost` when sidecar unresolvable
- [ ] ADR-019 Success Criteria met at check dates (≥ 99% Codex `/resume` over 50 runs by 2026-08-01; ≤ 50 ms p95 spawn latency; ≤ 0.01/1,000 sidecar-originated crash rate by 2026-10-01)
- [ ] `Azure/artifact-signing-action` (Track A) *or* SignPath/`signtool.exe` (Track B) pipeline confirmed against a non-test release candidate

## Tier Intent

Tier 2 per BL-078 exit criteria — daemon-foundational; pairs with Plan-001 (shared session core) and Plan-007 (local IPC host). Upstream of Plan-005 (runtime bindings) which is the first consumer of the `PtyHost` contract. Placement update to `docs/architecture/cross-plan-dependencies.md` §5 Canonical Build Order is out of scope for this plan and belongs to BL-054's propagation pass.

## References

- [ADR-019: Windows V1 Tier and Rust PTY Sidecar Strategy](../decisions/019-windows-v1-tier-and-pty-sidecar.md) — primary decision source
- [ADR-009: JSON-RPC IPC Wire Format](../decisions/009-json-rpc-ipc-wire-format.md) — Content-Length framing parity
- [ADR-016: Electron Desktop Shell](../decisions/016-electron-desktop-shell.md) — shared signing-identity policy
- [Spec-023: Desktop Shell And Renderer](../specs/023-desktop-shell-and-renderer.md) — Apple Developer ID + Azure Artifact Signing precedent; macOS notarization queue mitigation
- [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) — Tier 2 placement target for BL-054
- [portable-pty crate](https://github.com/wezterm/wezterm/tree/main/pty) — PTY backend, ≥ 0.9.0, WezTerm org
- [openai/codex#13973](https://github.com/openai/codex/issues/13973) — first-party ConPTY trigger (V1 driver)
- [microsoft/node-pty#904](https://github.com/microsoft/node-pty/issues/904) — SIGABRT on Electron exit
- [microsoft/node-pty#887](https://github.com/microsoft/node-pty/issues/887) — ConoutConnection worker strand
- [microsoft/node-pty#894](https://github.com/microsoft/node-pty/issues/894) — PowerShell 7 delay under `useConptyDll`
- [microsoft/node-pty#437](https://github.com/microsoft/node-pty/issues/437) — process-tree kill unreliable on Windows
- [microsoft/node-pty#647](https://github.com/microsoft/node-pty/issues/647) — spawn locks cwd on Windows
- [Eugeny/tabby#10134](https://github.com/Eugeny/tabby/issues/10134) — Tabby GA-on-node-pty rollback precedent
- [esbuild optionalDependencies pattern](https://www.npmjs.com/package/esbuild) — distribution precedent (26 platform packages as of 0.28.0 / 2026-04-02)
- [napi-rs v3 release notes](https://github.com/napi-rs/napi-rs) — platform-package + WASM fallback extension of the pattern
- [Azure Artifact Signing GA announcement (2026-01-12)](https://techcommunity.microsoft.com/blog/microsoft-security-blog/simplifying-code-signing-for-windows-apps-artifact-signing-ga/4482789) — product rename + GA date
- [Azure Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq) — eligibility geography, EV cert scope
- [CA/Browser Forum Ballot CSC-31](https://cabforum.org/working-groups/code-signing/requirements/) — 460-day cert-validity cap effective 2026-03-01
- [Apple Developer ID program](https://developer.apple.com/developer-id/) — Developer ID Application certificate
- [`xcrun notarytool` notarization workflow (Apple developer docs)](https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution/customizing_the_notarization_workflow) — `notarytool` + `stapler`; `altool` deprecated 2023-11-01
- [Apple Developer Forums thread 813441](https://developer.apple.com/forums/thread/813441) — 16+ hour notarization queue delays (Feb 2026+)
- [cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild) — v0.22.2 (2026-04-16); healthier than the stale `cross-rs/cross` v0.2.5 (2024-02-04)
- [cargo-zigbuild#316](https://github.com/rust-cross/cargo-zigbuild/issues/316) — aarch64-apple-darwin iconv linker regression under Rust ≥ 1.82 with `zstd-sys`
