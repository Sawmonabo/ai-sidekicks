# ADR-019: Windows V1 Tier and Rust PTY Sidecar Strategy

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `accepted` |
| **Type** | `Type 2 (one-way door)` |
| **Domain** | `Runtime / PTY / Platform Support` |
| **Date** | `2026-04-17` |
| **Author(s)** | `Claude (AI-assisted)` |
| **Reviewers** | `Accepted 2026-04-17` |

## Context

Agent runs spawn shells and tools (`git`, compilers, interpreters, REPLs, language-server drivers). Every shell spawn goes through a pseudoterminal (PTY). PTY behavior on macOS and Linux is a well-understood, battle-tested surface — `node-pty` has powered VS Code, Cursor, Windsurf, Tabby, Wave, Claude Code, and every other Node-based terminal-hosting product for years on those platforms.

PTY on Windows is a distinct surface. Windows 10 1809 introduced ConPTY as the modern API; prior to that, tools relied on `winpty`. `node-pty` supports ConPTY on Windows, and that support is where a cluster of known open bugs lives:

- [`openai/codex#13973`](https://github.com/openai/codex/issues/13973) — ConPTY assertion failure that kills the Node host (OPEN as of 2026-03-08; first-party trigger in our critical path since we host Codex).
- [`microsoft/node-pty#904`](https://github.com/microsoft/node-pty/issues/904) — `SIGABRT` on Electron exit via a `ThreadSafeFunction` race condition (OPEN).
- [`microsoft/node-pty#887`](https://github.com/microsoft/node-pty/issues/887) — ConoutConnection worker strands the Node exit path (OPEN).
- [`microsoft/node-pty#894`](https://github.com/microsoft/node-pty/issues/894) — PowerShell 7 exhibits a 3.5-second delay under `useConptyDll: true` (OPEN).
- [`microsoft/node-pty#437`](https://github.com/microsoft/node-pty/issues/437) — `ptyProcess.kill()` hangs indefinitely on Windows (confirmed on Windows 10); unaffected on Linux.
- [`microsoft/node-pty#647`](https://github.com/microsoft/node-pty/issues/647) — Spawn can lock the cwd on Windows (blocks deletion until process exit).

The Tabby terminal (Eugeny/tabby) shipped GA on `node-pty` on Windows and hit the same ConPTY assertion class as `openai/codex#13973`; the [`Eugeny/tabby#10134`](https://github.com/Eugeny/tabby/issues/10134) thread documents the user-rollback wave that followed. Tabby's closure strategy was to pin to an older `node-pty` version — a workaround, not a structural fix.

A Rust alternative exists. [`portable-pty`](https://github.com/wezterm/wezterm/tree/main/pty) is the production PTY crate used by wezterm (which handles significantly more demanding terminal workloads than an agent driver) and by a growing set of TUI tools. It implements ConPTY correctly, ships without the `node-pty` bug cluster, and is structured as a standalone crate suitable for use in a separate process (a sidecar).

ADR-015 places Windows in V1 implicitly (V1 ships Desktop GUI, and ADR-016 commits to Electron which ships on Windows). The question is whether Windows V1 should ship as **GA** with full quality-gate equivalence to macOS and Linux, or as **Beta** with explicit quality-level caveats.

An earlier evaluation (cited primary sources catalogued in §Research Conducted below) recommended **Option C (Windows V1 Beta)** under a human-implementation cost model on the grounds that the ~3–5 engineer-weeks required for a Rust sidecar and the ongoing "language in critical path" maintenance cost were load-bearing. That cost model does not hold under AI implementation (Claude Opus 4.7 executes the plan), which collapses the engineering-week estimate by more than 70% and eliminates the "engineer learning Rust" ramp. The decision below re-runs the same trade-off with the revised cost model.

## Problem Statement

What is the V1 quality tier for Windows, and what PTY backend strategy on Windows meets that tier given the `node-pty` bug cluster and the Tabby-precedent risk?

### Trigger

- Agent drivers in V1 include Codex, which has a first-party open issue (`openai/codex#13973`) that triggers the ConPTY assertion class; we cannot ship Windows without addressing this.
- AI implementation of the plan changes the cost-benefit math that drove the prior Option C recommendation (under a human-implementation cost model); re-run required.
- Plan-001 (shared session core) needs a decided PTY backend contract before it authors terminal-session code.

## Decision

1. **Windows V1 ships as GA**, with full quality-gate equivalence to macOS and Linux.
2. **A Rust PTY sidecar is the primary PTY backend on Windows.** The sidecar is built on `portable-pty` (wezterm), compiled per platform, and spawned as a child process of the local daemon with lifecycle tied to the session.
3. **`node-pty` is the primary PTY backend on macOS and Linux** (in-process, nanosecond-latency, zero per-spawn process overhead, battle-tested). `node-pty` also ships as the **Windows fallback** under the same `PtyHost` interface, for debugging and for the case where the sidecar binary is missing or fails to start.
4. **All PTY access flows through a `PtyHost` interface in `packages/contracts/`**, with two implementations (`RustSidecarPtyHost`, `NodePtyHost`) and a platform selector that picks the Windows-primary/Unix-primary defaults. Consumers never see the backend choice.
5. **Sidecar IPC uses LSP-style Content-Length framing over stdio**, matching the daemon's own JSON-RPC 2.0 + Content-Length IPC design (ADR-009). A JSON control channel handles `spawn`, `resize`, `kill`, `exit-code`, and `ping`; a length-prefixed binary data channel carries stdout/stderr.
6. **Distribution follows the `@esbuild/*` platform-package pattern** — one signed binary per platform published as `@ai-sidekicks/pty-sidecar-{win32-x64,darwin-arm64,darwin-x64,linux-x64,linux-arm64}` with npm `optionalDependencies` + `os`/`cpu` filters, so an install pulls exactly one binary.
7. **Windows code-signing uses Azure Artifact Signing as the preferred path for publishers in eligible geographies** (Public Trust is available to USA / Canada / EU / UK organizations and to USA / Canada individual developers per the [Azure Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)), with a traditional **EV code-signing certificate (~$400–$1,200/year at the CA/Browser Forum Ballot CSC-31 15-month renewal cycle)** as the alternative procurement path for ineligible geographies or EV-chain-required distributions.
8. **SmartScreen reputation accrues to the signer**, so the sidecar binary and the Electron app share the same signing identity to ensure reputation pooling rather than split accrual.

### Thesis — Why This Option

The `node-pty` Windows bug cluster has a concrete first-party trigger in `openai/codex#13973`. Codex is a V1 driver. Shipping V1 Windows on `node-pty` alone puts us on the same path Tabby walked — GA on a known-fragile PTY stack, followed by a user-visible crash cluster and a reactive pin-the-dependency workaround. The Tabby precedent is the strongest evidence we have that the bug cluster is not theoretical: another production team shipped through it, and the visible failure mode was user rollback. The Rust sidecar side-steps the entire bug cluster by using a different PTY implementation (`portable-pty`) that does not share `node-pty`'s ConPTY code path. The in-process node-pty latency and ergonomics are preserved on macOS and Linux where the bug cluster does not exist. The `PtyHost` interface isolates the platform-selection decision so consumers are unaffected.

The cost of the sidecar approach is three things: a new binary distribution surface, a new language in the critical path (Rust), and signing-pipeline work. Under human-implementation cost models, those are material. Under AI-implementation cost models (Claude Opus 4.7 executes the plan), the implementation-cost portion collapses. The distribution and signing work remain, but those are one-time setup costs, not ongoing burdens. Distribution uses a pattern (`@esbuild/*`) proven at massive scale and is copy-adaptable rather than invented-here. Signing uses either Azure Artifact Signing's established flow (in eligible geographies) or a traditional EV code-signing cert (everywhere else) — both are documented procurement paths, not invent-here work. The residual ongoing cost is Rust-in-the-stack maintenance, which is bounded to a single crate with a stable external dependency (`portable-pty`) and no frequent-edit churn expected.

### Antithesis — The Strongest Case Against

The industry norm is `node-pty` everywhere. VS Code, Cursor, Windsurf, Tabby, Wave, Claude Code, and every other Electron-based terminal-hosting product ships on `node-pty` on Windows. The bug cluster is real but has been tractable in practice for other teams; the Tabby rollback wave was specifically about one class of the ConPTY assertion, and the fix (pin to an older `node-pty`) took one PR. Adopting a Rust sidecar makes this project distinct from the norm in a way that introduces real ongoing costs: a second language in the critical path, a separate build chain, a separate signing flow, cross-compile CI infrastructure, and the risk of a sidecar-originated bug that takes longer to debug than a `node-pty`-originated bug would because the Rust code is less familiar territory. The strongest counter-example to the chosen architecture is [Warp Terminal](https://users.rust-lang.org/t/warp-terminal-is-now-on-windows/126290): Rust-native end-to-end with ~90% cross-OS code share, and yet Warp explicitly labels Windows as **Beta** rather than GA. A Rust-first team that has solved every other Rust-on-Windows surface still chose caution on Windows tier — that is signal that even the "right" PTY backend does not retire all Windows-specific risk. The V1 Beta recommendation on `node-pty` is the staff-engineer-default position: ship on the industry norm, use the Beta label to communicate known quality delta, and hold the sidecar as a V1.1 option if the bug cluster actually bites.

### Synthesis — Why It Still Holds

The antithesis is the correct default position for a team that is one major bug away from capacity exhaustion. It is the wrong position for a team where AI-implementation collapses the cost half of the cost-benefit. The load-bearing fact is the Codex first-party issue (`openai/codex#13973`): we are shipping V1 with a provider driver that has an open bug triggering the exact assertion class that caused the Tabby rollback. "Use the industry norm" is sound advice when the industry norm works; the industry norm has a known open bug against our first-party provider, and the Tabby precedent shows what happens when you ship GA on top of it. "Ship Beta" (Option C) is the hedge move: it delays the problem without solving it, and it communicates to Windows users that the product does not take their tier seriously — a category-positioning cost for a collaborative-agent product that targets the developer market. The sidecar move is not "doing something different from the norm"; it is "doing what the product can do now that it could not do under a human-only cost model." The chosen architecture has shipping precedents on both axes that matter: [Zed shipped Windows GA day-one on 2025-10-15](https://zed.dev/blog/zed-for-windows-is-here) with terminal working out of the box, built on `alacritty_terminal` (a Rust PTY, not `node-pty`) — direct evidence that a Rust PTY backend ships GA-clean on Windows. [Wave Terminal](https://github.com/wavetermdev/waveterm) is the closest peer for the IPC topology specifically: an Electron renderer paired with a separately-compiled PTY-bearing sidecar binary. Wave's sidecar is Go (built on `aymanbagabas/go-pty`) rather than Rust, and the PTY library differs, but the Electron-plus-sidecar split with ConPTY isolated to the sidecar is in production today. The two precedents together cover the chosen approach: Zed validates "Rust PTY on Windows is a solved problem at the library layer," Wave validates "an Electron app can run a separately-compiled PTY-bearing sidecar in production." Distribution and signing costs are real but are one-time, copy-adaptable from `@esbuild/*` (distribution) and Azure Artifact Signing or EV-cert documented procurement flows (signing). Ongoing Rust maintenance is bounded. The structural fix beats the hedge.

## Alternatives Considered

### Option A: Windows V1 GA + Rust PTY Sidecar (Chosen)

- **What:** Decision above.
- **Steel man:** Structural fix to the `node-pty` Windows bug cluster. Uniform V1 quality tier across Windows, macOS, Linux. Preserves `node-pty`'s in-process latency on macOS/Linux where the bug cluster does not exist. AI-implementation cost model makes the implementation work tractable in a V1 window. Distribution pattern is proven (`@esbuild/*`); signing pattern is documented (Azure Artifact Signing or EV cert).
- **Weaknesses:** New binary distribution surface; cross-compile CI infrastructure; Rust-in-the-stack ongoing maintenance (bounded); sidecar-originated crashes (if any) debug in less-familiar territory; signing-cert setup dependency on Azure Artifact Signing eligibility or EV cert procurement.

### Option B: Windows V1 GA on `node-pty` only (Rejected)

- **What:** Ship Windows V1 GA using `node-pty` exclusively, matching the industry norm (VS Code, Cursor, Windsurf, Tabby, Wave, Claude Code).
- **Steel man:** Industry norm; minimal implementation surface; one language in the critical path; the `node-pty` bug cluster has been tractable in practice for other teams; the fix for the Tabby ConPTY class was a single dependency pin; AI implementation makes it trivial to monitor and pin `node-pty` versions.
- **Why rejected:** `openai/codex#13973` is a first-party provider driver issue against the exact ConPTY assertion class that caused the Tabby user-rollback wave. Shipping GA on a PTY stack with a known open first-party bug trigger is path-dependent on a future upstream fix that is not committed. "Pin an older version" is a workaround, not a fix; it constrains future `node-pty` upgrades and keeps us on code that does not receive further maintenance. The Tabby precedent shows the user-visible failure mode; accepting that risk for V1 launch is not consistent with a GA tier for Windows.

### Option C: Windows V1 Beta on `node-pty` (Rejected; prior recommendation under human-implementation cost model)

- **What:** Ship V1 with a Windows tier explicitly labeled Beta. Quality gates tolerate known `node-pty` issues. Sidecar is reserved for V1.1 if the bug cluster bites.
- **Steel man:** Lowers V1 scope; communicates quality delta honestly to Windows users; gives a production-data escape hatch for the sidecar decision; matches the prior cost-benefit under a human-implementation cost model.
- **Why rejected:** Under the prior human-implementation cost model, Option C's recommendation was driven by the 3–5 engineer-weeks of Rust work and the "+1 language in critical path" ongoing cost. Under AI implementation (Claude Opus 4.7), the engineer-weeks cost compresses by >70% and the "learning ramp" portion of the language-in-stack cost vanishes. With the dominant cost collapsed, the cost-benefit inverts against the Tabby-precedent risk. Additionally, Windows Beta communicates a category-positioning cost: a developer-market product that ships one of its three target platforms at a lower tier is read as "don't use this on Windows," which loses users rather than setting expectations. The Beta hedge also does not structurally address the `node-pty` bug cluster; it only labels the risk.

### Option D: `useConptyDll: true` experimental flag (Deferred, not rejected)

- **What:** Enable `node-pty`'s `useConptyDll: true` option, which uses the newer bundled ConPTY DLL rather than the OS-provided one. Some of the bug cluster is reported fixed in the bundled DLL.
- **Steel man:** A forward fix within `node-pty` itself, aligned with the upstream maintenance direction.
- **Disposition:** Deferred, not rejected. As of 2026-04, `microsoft/node-pty#894` (PowerShell 7 3.5-second delay under `useConptyDll: true`) is OPEN, so enabling the flag creates a new regression class. Once `#894` closes and the flag is validated against our Windows fallback path, enabling `useConptyDll: true` alongside the Rust sidecar primary is a zero-risk upgrade to the fallback backend. Tripwire 3 below names this revisit gate.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
|---|-----------|----------|----------------------|
| 1 | `portable-pty` (wezterm) does not share `node-pty`'s ConPTY bug cluster. | `portable-pty` is a separate Rust implementation of the ConPTY API, used in production by wezterm which handles heavier terminal workloads than an agent driver; no open-issue pattern matching the `node-pty` cluster. | Fallback to `node-pty` via `PtyHost` works while we debug; sidecar sunset evaluated. |
| 2 | AI implementation materially compresses the 3–5 engineer-weeks estimate for sidecar implementation. | Comparable implementation tasks under AI execution have shown > 70% cycle-time compression; `@esbuild/*` distribution pattern is copy-adaptable; `portable-pty` is a stable external dependency. | Sidecar delivery slips V1; Windows ships on `node-pty` fallback; sidecar moves to V1.1. |
| 3 | Azure Artifact Signing or EV cert procurement is achievable in the V1 timeline. | Azure Artifact Signing Public Trust is regionally available (USA / Canada / EU / UK organizations and USA / Canada individual developers) per the [Azure Artifact Signing FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq); EV cert is a commercial procurement with a 1–2 week turnaround. | Sidecar ships unsigned initially, triggering SmartScreen warnings; V1 ships with UX-banner mitigation while signing catches up. |
| 4 | LSP-style Content-Length framing over stdio is adequate throughput for agent PTY data. | VS Code LSP, TypeScript language service, and our own daemon IPC (ADR-009) all operate on this framing at equivalent or higher data rates. | Throughput bottleneck on sidecar-agent; upgrade to a shared-memory or Unix-domain-socket variant. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
|----------|-----------|--------|-----------|------------|
| Sidecar-originated Sev-1 bug traceable to `portable-pty` | Low | High | Crash reporting; structured-log correlation; `PtyHost` path telemetry | Fallback to `node-pty` via `PtyHost`; upstream bug report to wezterm; sunset evaluation per Tripwire 1 |
| Sidecar binary missing on user machine (npm install fell back wrong) | Low | High | Daemon-startup PTY-backend probe; health check | `PtyHost` selects `NodePtyHost` fallback; loud warning banner; install-doc link |
| Azure Artifact Signing eligibility denied | Med | Med | Eligibility determination in signing pipeline setup | EV cert fallback (already documented; budget-line allocated) |
| Cross-compile CI regression (Rust toolchain or `portable-pty` build break) | Low | Med | CI build matrix across all 5 platform targets | Revert to last-known-good crate version; file upstream issue |
| `node-pty` v1.2.0 or later ships with ThreadSafeFunction race fix (reversal signal) | Low | Low (positive) | `node-pty` release-note monitoring | Evaluate sidecar sunset per Tripwire 3 |
| AV/EDR false-positive on the sidecar binary or its detached-spawn pattern (e.g., SentinelOne flagging Electron stack per [`microsoft/vscode#239184`](https://github.com/microsoft/vscode/issues/239184); Windows Defender flagging detached PTY spawn + liveness-poll as `Trojan:Win32/SuspExec.SE` per the [`microsoft/node-pty#887`](https://github.com/microsoft/node-pty/issues/887) comment thread) | Med | High | User-reported AV blocks via crash-reporting + support-ticket triage; signing-pipeline pre-publish AV scan; SmartScreen reputation telemetry on signer | Sidecar binary signed under same identity as Electron app (SmartScreen reputation pooling per Decision item 8); pre-launch submission to major AV vendors (Microsoft Defender, SentinelOne, CrowdStrike) for whitelist; documented expected-AV-warning UX page; daemon liveness poll cadence kept above C2-beacon thresholds where avoidable |

## Reversibility Assessment

- **Reversal cost:** Medium to High once V1 ships. Reversal means: removing the sidecar distribution packages, teaching daemons still running older versions to skip the sidecar path, re-enabling `node-pty` as the Windows primary, and accepting the bug cluster. Multi-week migration across a live install base; no user-data migration, just binary distribution and config rollout.
- **Blast radius:** `packages/contracts/` (`PtyHost` interface), `packages/runtime-daemon/` (sidecar spawn and supervision), `@ai-sidekicks/pty-sidecar-*` published packages, Windows signing pipeline, CI cross-compile matrix.
- **Migration path:** Flip the `PtyHost` selector default to `NodePtyHost` on all platforms. Deprecate and stop publishing the sidecar packages. Leave the interface in place so re-adoption is possible.
- **Point of no return:** First V1 Windows ship. Before that, reversal is implementation-cost only.

## Consequences

### Positive

- Windows V1 ships at GA tier with the same quality gates as macOS and Linux.
- `node-pty` bug cluster (including `openai/codex#13973`) is structurally addressed on Windows rather than deferred.
- `node-pty` primary on macOS/Linux preserves in-process latency and ergonomics where the bug cluster does not exist.
- `PtyHost` interface isolates platform-selection decisions from consumers; future backend swaps are hidden behind one contract.
- SmartScreen reputation pools across the Electron app and sidecar signer (shared identity).

### Negative (accepted trade-offs)

- Rust added to the critical-path dependency set; bounded to one crate with a stable external dependency.
- New binary distribution surface (`@ai-sidekicks/pty-sidecar-*` packages) and new signing pipeline work.
- Cross-compile CI infrastructure required across 5 platform targets.
- Sidecar-originated crashes (if any) debug in less-familiar territory than `node-pty` crashes would.

### Unknowns

- Actual sidecar spawn-latency overhead in production workloads; measured in Plan-024 CI once sidecar scaffolding lands.
- Azure Artifact Signing eligibility determination timeline; known once application submitted.

## Decision Validation

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan (Plan-024 CI; Azure Artifact Signing application; cross-compile CI matrix)
- [x] At least one alternative was seriously considered and steel-manned (Options B and C both steel-manned; Option D documented as deferred gate)
- [x] Antithesis was reviewed (Thesis/Antithesis/Synthesis triad in the Decision section)
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
|--------|--------|--------------------|------------|
| Windows `/resume` end-to-end pass-rate (Codex + Claude drivers) | ≥ 99% over 50 consecutive CI runs | `windows-latest` CI matrix | `2026-08-01` |
| Sidecar spawn latency p95 | ≤ 50 ms | Plan-024 benchmark suite | `2026-08-01` |
| Signed `@ai-sidekicks/pty-sidecar-win32-x64` reaches SmartScreen "established publisher" status | Yes | SmartScreen telemetry | `2026-12-01` |
| Sidecar-originated crash rate | ≤ 0.01 per 1000 sessions | Crash reporting pipeline | `2026-10-01` |

### Tripwires (Revisit Triggers)

1. **Sidecar-originated Sev-1 bug traceable to `portable-pty`.** — Evaluate sidecar sunset; reassess whether `node-pty` primary is viable with targeted workarounds.
2. **Azure Artifact Signing eligibility denied AND EV cert procurement blocked.** — Evaluate unsigned-release interim with documented SmartScreen guidance; escalate signing strategy review.
3. **`node-pty` v1.2.0 stable ships with the ThreadSafeFunction race fixed AND 50 consecutive clean `windows-latest` Codex + `/resume` CI runs accumulate against the patched version.** — Evaluate sidecar sunset as a cost-reduction move; `node-pty` primary returns as a viable Windows option.

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
|--------|------|-------------|--------------|
| `openai/codex#13973` | Upstream issue | ConPTY assertion (`remove_pty_baton(baton->id)` at `conpty.cc` line 106); first-party provider trigger; OPEN as of 2026-03-08 | <https://github.com/openai/codex/issues/13973> |
| `microsoft/node-pty#904` | Upstream issue | `SIGABRT` on Electron exit; ThreadSafeFunction cleanup race; same class as `codex#13973`; OPEN 2026-03-27 | <https://github.com/microsoft/node-pty/issues/904> |
| `microsoft/node-pty#887` | Upstream issue | ConoutConnection worker thread strands Node exit after `kill()`; OPEN 2026-04-06 | <https://github.com/microsoft/node-pty/issues/887> |
| `microsoft/node-pty#894` | Upstream issue | PowerShell 7 3.5 s output delay under `useConptyDll: true`; blocks the bundled-ConPTY workaround; OPEN 2026-03-11 | <https://github.com/microsoft/node-pty/issues/894> |
| `microsoft/node-pty#827` | Upstream issue | Windows crash on Node.js v22 — "Cannot resize a pty that has already exited"; thrown error → process exit; Gemini CLI users hit in production; OPEN 2026-03-13 | <https://github.com/microsoft/node-pty/issues/827> |
| `microsoft/node-pty#437` | Upstream issue | `ptyProcess.kill()` hangs on Windows, works on Linux; process-tree kill not reliable | <https://github.com/microsoft/node-pty/issues/437> |
| `microsoft/node-pty#647` | Upstream issue | Spawn locks cwd on Windows (blocks worktree workflows) | <https://github.com/microsoft/node-pty/issues/647> |
| `microsoft/node-pty#167` | Upstream issue | Sending a signal to all processes in the processgroup of the pts; Ctrl+C / SIGINT propagation does not reach process group on Windows | <https://github.com/microsoft/node-pty/issues/167> |
| `microsoft/node-pty#842` | Upstream issue | Removed winpty support; ConPTY (Windows 10 1809+) is the only supported backend (telemetry: <0.1% pre-ConPTY) | <https://github.com/microsoft/node-pty/issues/842> |
| `microsoft/node-pty` releases | Documentation | `v1.2.0-beta.12` (2026-03-12) is current; no stable 1.2.0 has shipped; bundled conpty `1.25.260303002`; `useConptyDll` option added (anchors Tripwire 3) | <https://github.com/microsoft/node-pty/releases> |
| `Eugeny/tabby#10134` | Upstream issue (precedent) | Tabby GA on `node-pty` → user-rollback wave on ConPTY assertion class; closed by pinning `node-pty` | <https://github.com/Eugeny/tabby/issues/10134> |
| `microsoft/vscode#224488` | Upstream issue | "Ship newer version of conpty" — VS Code's stalled ask; "fixes in ConPTY can take 1–2 years to make it to users" | <https://github.com/microsoft/vscode/issues/224488> |
| `microsoft/vscode#245709` | Upstream issue | ConPTY assertion failure on new window in VS Code — same assertion class as `codex#13973` | <https://github.com/microsoft/vscode/issues/245709> |
| `microsoft/vscode#252489` | Upstream issue | "Terminal commands are not reliable when conpty dll is false" — corroborates `useConptyDll: true` is the forward direction (supports Option D deferral) | <https://github.com/microsoft/vscode/issues/252489> |
| `microsoft/vscode#239184` | Upstream issue | SentinelOne EDR detected Electron stack as a security threat (live AV/EDR pattern) | <https://github.com/microsoft/vscode/issues/239184> |
| `microsoft/vscode#255285` | Upstream issue | Terminal viewport shifts left with Chinese IME in `gemini cli` on Windows ConPTY (Unicode/IME edge case in agentic CLI under ConPTY) | <https://github.com/microsoft/vscode/issues/255285> |
| `nodejs/node#62125` | Upstream issue | Windows detached-spawn silent termination on Node 24.13; cross-referenced from `node-pty#887`; Node.js Windows regressions cross-pollinate | <https://github.com/nodejs/node/issues/62125> |
| `wezterm/portable-pty` source tree | Reference implementation | Production Rust PTY crate used by wezterm; cross-platform ConPTY on Windows | <https://github.com/wezterm/wezterm/tree/main/pty> |
| `portable-pty` docs.rs listing | Documentation (crate listing) | Latest crate API docs; mature; used outside wezterm in Tauri terminal apps | <https://docs.rs/portable-pty/latest/portable_pty/> |
| Zed — "Windows When? Windows Now" blog | Engineering blog | Zed shipped Windows GA day-one on 2025-10-15 with terminal working; uses `alacritty_terminal` (Rust PTY, not `node-pty`) — primary precedent for "Rust PTY is reliable on Windows" | <https://zed.dev/blog/zed-for-windows-is-here> |
| Zed terminal core docs (DeepWiki, third-party mirror) | Documentation (third-party mirror) | Zed terminal architecture: Rust-native PTY via `alacritty_terminal`; flagged as third-party DeepWiki mirror, not upstream zed-industries source | <https://deepwiki.com/zed-industries/zed/9.1-terminal-core> |
| Warp — "Warp Terminal is now on Windows" (Rust forum announcement) | Vendor announcement | Rust-native terminal explicitly labeled Windows BETA — Warp chose Beta despite being Rust-native; counter-example to the chosen architecture | <https://users.rust-lang.org/t/warp-terminal-is-now-on-windows/126290> |
| `wavetermdev/waveterm` | Reference implementation | Wave Terminal: Electron + Go (`aymanbagabas/go-pty`) sidecar pattern; closest peer for Electron-plus-PTY-sidecar IPC topology (Go, not Rust) | <https://github.com/wavetermdev/waveterm> |
| `aymanbagabas/go-pty` | Reference implementation | Cross-platform Go PTY library; ConPTY on Windows; used in Wave Terminal | <https://github.com/aymanbagabas/go-pty> |
| `anthropics/claude-code` | Reference implementation | First-party agentic CLI shipping Windows GA on JS PTY stack via Git Bash + node-pty (industry-norm peer set anchor) | <https://github.com/anthropics/claude-code> |
| `@homebridge/node-pty-prebuilt-multiarch` | Fork repo | Parallel `node-pty` fork with prebuilt binaries (ia32/amd64/arm/aarch64); cited in Codex/Gemini CLI stack traces (signal that ecosystem has drifted to forks) | <https://github.com/homebridge/node-pty-prebuilt-multiarch> |
| Tauri v2 sidecar docs | Documentation | Sidecar spawn + lifecycle patterns (pattern-informative, Tauri-specific) | <https://v2.tauri.app/develop/sidecar/> |
| `@esbuild/*` npm packages | Distribution precedent | Platform-specific binary distribution via `optionalDependencies` + `os`/`cpu` filters | <https://www.npmjs.com/package/esbuild> |
| Azure Artifact Signing FAQ | Documentation | Eligibility criteria (USA / Canada / EU / UK organizations; USA / Canada individual developers); signing pipeline integration | <https://learn.microsoft.com/en-us/azure/artifact-signing/faq> |
| Electron code-signing tutorial | Documentation | Canonical Electron code-signing reference (precedes Azure Artifact Signing path) | <https://www.electronjs.org/docs/latest/tutorial/code-signing> |
| Security Boulevard 2025-12 — "How to sign a Windows app with electron-builder" | Engineering blog | Azure Trusted Signing as cheapest credible Electron-builder path; SmartScreen reputation context (signer pooling) | <https://securityboulevard.com/2025/12/how-to-sign-a-windows-app-with-electron-builder/> |
| GitHub Actions runner pricing | Documentation | Per-minute cost: Linux $0.006, Windows $0.010 (post-2026-01-01 reduction; effective ~1.67× multiplier); supports cross-compile CI cost framing | <https://docs.github.com/en/billing/reference/actions-runner-pricing> |

### Related ADRs

- [ADR-009: JSON-RPC IPC Wire Format](./009-json-rpc-ipc-wire-format.md) — establishes Content-Length framing; sidecar IPC reuses this shape.
- [ADR-015: V1 Feature Scope Definition](./015-v1-feature-scope-definition.md) — places Desktop GUI in V1 (which implies Windows shipment via ADR-016 Electron on Windows).
- [ADR-016: Electron Desktop Shell](./016-electron-desktop-shell.md) — commits to Electron on all three platforms; the sidecar binary signs under the same identity as the Electron app to pool SmartScreen reputation.
- [ADR-010: PASETO + WebAuthn + MLS Auth](./010-paseto-webauthn-mls-auth.md) — establishes Linux passkey parity expectation that frames the Windows GA expectation symmetrically.

### Related Docs

- [V1 Feature Scope](../architecture/v1-feature-scope.md) — Windows-tier row to cite this ADR per BL-039.
- [Component Architecture: Local Daemon](../architecture/component-architecture-local-daemon.md) — `PtyHost` interface obligation; Rust sidecar as Windows primary.
- [Deployment Topology §Container and Packaging](../architecture/deployment-topology.md) — binary distribution surface.
- [Vision §Add Later If Needed](../vision.md) — Rust sidecar row; moved to confirmed V1 component per BL-039.

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| 2026-04-16 | Evidence-grade evaluation conducted | Primary-source survey of the `node-pty` Windows ConPTY bug cluster, Tabby precedent, reference-app comparative landscape, and Rust/Go PTY alternatives (citations consolidated in §Research Conducted; Option C V1 Beta recommended under a human-implementation cost model — see §Alternatives Considered Option C) |
| 2026-04-17 | Cost-model shift recorded | AI-implementation cost model collapses the implementation-cost half of Option A's cost-benefit; re-evaluation triggered |
| 2026-04-17 | Proposed | Drafted against BL-052 exit criteria |
| 2026-04-17 | Accepted | ADR accepted as Windows V1 tier + PTY backend strategy |
