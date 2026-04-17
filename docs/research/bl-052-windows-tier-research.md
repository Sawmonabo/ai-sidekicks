# BL-052: Windows V1 Tier — Research Brief

**Date:** 2026-04-16
**Question:** Does Windows ship as V1 GA tier (feature parity with macOS/Linux) or as V1 beta tier (documented caveat, partial support)?
**Scope:** Decision-grade brief for the team. `PtyHost` interface in `packages/contracts/` is treated as a **non-decision** per backlog — it happens regardless of tier choice. The live decision is GA-vs-Beta **and** whether to pull the Rust PTY sidecar into V1 scope.

---

## 1. Problem Framing

### 1.1 The trigger

`openai/codex#13973` (2026-03-08, OPEN): Windows users hit a Microsoft Visual C++ assertion dialog — `Assertion failed! … conpty.cc Line: 106, Expression: remove_pty_baton(baton->id)` — which appears both under a Codex-specific config-error path *and*, per a second reporter (`temsan`, Version 26.313.41514), during ordinary Codex desktop-app shutdown. The Codex reporter (`TheDutchRuler`) eventually traced his original crash to a Codex config-path resolution bug (`.codex/` prefix doubling), which is Codex-app-specific. But the shutdown-crash reproducer is a plain node-pty ThreadSafeFunction race, not a Codex integration bug. See `openai/codex#13973` and the related upstream issue `microsoft/node-pty#904` below.

Our use case is an exact match for the failing pattern: daemon spawns `codex` CLI under node-pty on Windows, expected to support resume.

### 1.2 What's already decided (non-decisions)

- **`PtyHost` interface in `packages/contracts/`** — happens regardless of tier. node-pty is one implementation; a future Rust sidecar can swap in. The report does not re-debate this.
- **Electron was chosen over Tauri/Wails** — because WebKitGTK has no WebAuthn in 2026 and we need Linux passkey. That is signal: the project has paid a framework-level cost for per-platform polish. A "Windows Beta" label in V1 is compatible with this only if it is framed as **explicit, time-boxed deferral**, not as "we don't care about Windows."
- **Codex CLI + node-pty is the first-party integration** we will ship to Windows users who have OpenAI Codex. Any option the brief recommends must stay compatible with that integration.

### 1.3 The real choice

Three options. A = GA + sidecar in V1. B = GA with node-pty only. C = Beta. Option B is the **industry norm** (VS Code, Cursor, Windsurf, Wave, Tabby all ship Windows GA on node-pty). The question for us is whether Codex's specific fragility and our smaller engineering capacity changes that equation.

---

## 2. 2026 PTY Landscape

### 2.1 State of node-pty on Windows (primary)

- **Latest release:** `v1.2.0-beta.12` (2026-03-12). All recent releases are beta-tagged — no stable 1.2.0 has shipped as of research date. `v1.2.0-beta.11` fixed a Windows ConPTY debugger-event-loop issue. `v1.2.0-beta.12` bumped the bundled conpty to `1.25.260303002`. (`microsoft/node-pty/releases`)
- **Backend:** winpty support **was removed** in late 2025 per `microsoft/node-pty#842`; Windows 10 1809+ (ConPTY) is now the only supported backend. Telemetry cited by maintainers: <0.1% of terminals were on pre-ConPTY Windows.
- **New capability: `useConptyDll` option** — node-pty can now bundle its own `conpty.dll` instead of relying on system ConPTY, mirroring what Windows Terminal and WezTerm do. This is the same pattern VS Code asked for in `microsoft/vscode#224488`: "fixes in ConPTY can take 1–2 years to make it to users." Relevant because our recommendation depends on whether bundled ConPTY is viable today.
- **`useConptyDll` has a live cost:** `microsoft/node-pty#894` (2026-03-11, OPEN): `Severe output delay (~3.5s) when using useConptyDll: true with PowerShell 7`. So turning on the modern path buys us ConPTY v2 features at the price of a PowerShell 7 regression. This is not theoretical — it's a current, open bug against the exact option that would let us skip the OS-ConPTY version dance.

### 2.2 Live Windows node-pty bugs that affect our exact use case

Open, Windows-tagged, 2026-current issues on `microsoft/node-pty` (selected — evidence-bearing for the decision):

| # | Issue | Status | Relevance |
|---|---|---|---|
| 904 | `SIGABRT crash during Electron process exit (ThreadSafeFunction cleanup race)` | OPEN, 2026-03-27 | **Same class as `codex#13973`.** Reproducible on Electron window close with active PTY sessions. Root cause: node-pty callback fires after `node::FreeEnvironment()` begins teardown, triggers `abort()`. |
| 887 | `Windows: ConoutConnection worker thread prevents Node.js from exiting after kill()` | OPEN, 2026-04-06 | Daemon lifecycle — we kill PTY processes as part of session teardown; this can strand the daemon. |
| 894 | `Severe output delay (~3.5s) with useConptyDll: true + PowerShell 7` | OPEN, 2026-03-11 | Blocks the clean "use bundled ConPTY" workaround. |
| 827 | `Windows crash on Node.js v22 – "Cannot resize a pty that has already exited"` | OPEN, 2026-03-13 | Thrown error, not native crash, but uncaught → process exit. Gemini CLI users hit this in production. |
| 437 | `Unable to kill pty process on Windows` | OPEN (long-lived) | Process tree kill is not reliable on Windows. |
| 647 | `spawn locks cwd on Windows` | OPEN | Breaks worktree workflows; we have worktree-execution in V1. |

**Verdict on the trigger bug (13973):** no dedicated upstream `baton`-keyword tracking issue exists in `microsoft/node-pty` as of research date (searched all states). The closest upstream cousin is `#904` (SIGABRT on Electron exit), which is a clear ThreadSafeFunction race. Inference: **the trigger bug is not upstream-triaged yet**, which means betting on an upstream fix inside our V1 timeline is speculative.

### 2.3 node-pty forks in the wild

- `@homebridge/node-pty-prebuilt-multiarch` — parallel fork with prebuilt ia32/amd64/arm/aarch64 binaries for macOS/Windows/Linux. Actively maintained 2025. Use case: avoid `node-gyp` at install time. Relevant because `@homebridge/...` is what a couple of the Codex/Gemini CLI stack traces referenced — **the ecosystem has already drifted to forks for a reason**, and any "just pin upstream node-pty" plan has to contend with that.
- `@lydell/node-pty` — another fork seen in Gemini CLI stack traces (`#827`).

### 2.4 PTY alternatives

**Rust-side (direct sidecar candidates):**

- **`portable-pty` (wezterm monorepo)** — cross-platform, used by wezterm itself in production on macOS/Linux/Windows; ConPTY on Windows. Lives inside the wezterm monorepo (not a standalone repo), so dependency on it means dependency on wezterm's release cadence. Latest crates.io version `0.9.0`. Mature, used outside wezterm in Tauri terminal apps per the crate's usage reports.
- **`conpty`** (standalone crate, `crates.io`) — narrower scope; Windows-only.
- **`winpty-rs`** (andfoy) — legacy, rarely relevant now that winpty is dead upstream.

**Go-side (if we were polyglot):**

- **`aymanbagabas/go-pty`** — cross-platform, Unix PTY + Windows ConPTY. Used in various Go TUI stacks.
- **`creack/pty`** — historically Unix-only; Windows ConPTY support has been in PR churn for years (`#95`, `#109`, `#155`, `#169`) and is not clean.

**Bun/Deno built-ins:** Bun has a PTY module (`bun:pty`, beta) as of 2025; Deno relies on `ffi` + `node-pty` compatibility. Neither is a credible V1 production dependency for a cross-platform Electron app.

### 2.5 Reference-app survey (what modern devtools actually ship)

| App | Stack | Windows tier | PTY strategy |
|---|---|---|---|
| **VS Code** | Electron + node-pty | **GA** (primary platform) | node-pty pinned; open issues on `terminal-conpty` list as of 2026-04: duplicate output on resize (#308519), kill-task leaks (#242891, regression), ConPTY IME on TUI (#255285), ConPTY assertion on new window (#245709), still-pending "ship newer conpty" (#224488). **Key signal:** VS Code ships GA *with known, long-lived Windows terminal bugs*. |
| **Cursor** | VS Code fork | GA | Inherits VS Code's node-pty stack. No independent Windows PTY work visible. |
| **Windsurf (Codeium)** | VS Code fork | GA | Same inheritance; terminal feeds into Cascade agent mode. |
| **Wave Terminal** | Electron + Go backend | Cross-platform GA | Go side uses `aymanbagabas/go-pty` (ConPTY). Precedent for *non-Node* PTY in an Electron app. |
| **Tabby** | Electron + Angular | GA, **but** | Hit the exact same ConPTY assertion (`conpty.cc` line 110) in `Eugeny/tabby#10134` — reporters downgraded to 1.0.215. Issue was confirmed by maintainers and closed Aug 2025 after node-pty version was pinned. Live data point for "GA apps hit this, then scramble." |
| **Zed** | Rust-native (not Electron) | GA on Windows as of 2025-10-15 per official blog | Built on `alacritty_terminal`; PTY via Rust (not node-pty). Terminal works on Windows same-day as launch. Precedent for "Rust PTY is done and reliable on Windows." |
| **Warp** | Rust-native | **Windows in beta** as of 2025–2026 | Rust-first, 90% code shared cross-OS per warpdotdev. Windows is explicitly labeled beta — Warp chose C (not A or B) despite being Rust-native. |
| **GitHub Desktop** | Electron | Terminal not first-class | No terminal; dodged the question. |
| **Claude Code (Anthropic)** | Node CLI (PowerShell installer) | **GA native on Windows** as of 2025 (previously WSL-only) | Runs via Git Bash on Windows. Uses node's child_process + (per repo inspection and ecosystem convention) node-pty for PTY operations. Precedent for "first-party agentic CLI shipping Windows GA on the JS PTY stack." |

**Reference-app takeaway:** GA on node-pty + ConPTY is the industry norm. Of our peer set, the only shipped apps in **beta on Windows** are Warp (Rust-native but chose caution) and certain older Electron terminals. VS Code's practice — ship GA, absorb a long tail of open terminal-conpty bugs — is the dominant pattern. That favors Option B over C for *normal* apps. Our question is whether Codex's specific fragility is a strong-enough delta from "normal" to change the answer.

---

## 3. Rust PTY Sidecar — Production Evidence

### 3.1 Does anyone actually ship a Rust PTY sidecar alongside a Node/Electron main?

**Direct evidence is thin.** The pattern exists but is not common among major shipping devtools:

- **Tauri apps** routinely use `portable-pty` from the Rust main process — but that's not a sidecar, that's the main process.
- **Wave Terminal** uses a **Go** (not Rust) PTY backend, bundled as a sidecar binary next to Electron. IPC is over a local HTTP/websocket link. This is the closest real-world analog to what we'd do, and it shows the pattern *works* — but Wave's team maintains a Go codebase primarily, which changes the ongoing-maintenance math.
- **VS Code** does not use a Rust sidecar for PTY. They ship node-pty, accept the bug tail, and have tried to push improvements upstream (`microsoft/vscode#224488`, `microsoft/node-pty#490`).
- **Zed** is Rust-native end-to-end, not a sidecar pattern.

**Inference (marked):** I did not find a single headline Electron devtool that runs a **Rust** sidecar *specifically for PTY* in production. The pattern is "Rust for the whole app" (Zed/Warp) or "Go sidecar" (Wave) or "node-pty in-process" (everyone else). A Rust PTY sidecar for an Electron/Node daemon would be mildly unusual in 2026, though not novel.

### 3.2 IPC, serialization, binary distribution

If we built one:

- **IPC:** Unix domain socket / named pipe with length-prefixed framing would match our existing daemon JSON-RPC 2.0 + LSP-style Content-Length design. Stdio is cleanest for a sidecar lifecycle tied to a single parent. Named pipe is more robust if the sidecar outlives multiple sessions.
- **Serialization:** JSON for control channel (spawn, resize, kill, exit-code) and raw binary for the data channel (stdout/stderr bytes). Protobuf or MessagePack add ops/build cost we don't need at V1 scale.
- **Build/distribution:** Tauri-style externalBin with `-$TARGET_TRIPLE` suffix. For us (Electron + npm): ship the Rust binary as a platform-specific npm package (`@ai-sidekicks/pty-sidecar-win-x64`, `-darwin-arm64`, etc.) with optional-dependencies + `os`/`cpu` filters, the way `@esbuild/*` and `@swc/core-*` packages work today. This is a solved distribution problem.
- **Code-signing:** On Windows, the Rust binary must be signed along with the Electron app. SmartScreen reputation accrues to the **signer**, not the individual binary, so one EV cert or (preferably in 2026) **Azure Trusted Signing** covers both. Azure Trusted Signing is now the cheapest credible path per Electron-builder guides (exact list price not verified here); it clears SmartScreen for US/Canada orgs with 3+ years of verifiable business history and avoids the HSM hardware friction of classic DigiCert EV (~$325–$581/yr per SSL resellers).

### 3.3 Rough cost (inference)

- **Upfront:** 3–5 engineer-weeks to build a minimal `PtyHost`-conformant Rust sidecar on `portable-pty`, including cross-platform build matrix, signing, and a golden-path integration test. This is **if** we already have Rust discipline in the team; otherwise double it.
- **Ongoing:** One additional build target per platform (3 binaries), one additional release artifact to sign, one additional `cargo update` cadence, one additional language in the team's critical path. Non-trivial but amortizable.
- **Risk surface:** A new IPC boundary introduces its own bugs (framing, backpressure, signal relay) that we would own. The sidecar fixes the `remove_pty_baton` assertion but introduces our own bugs in its stead — the trade is "known-bug tail we don't own" vs. "unknown-bug tail we do own."

---

## 4. Windows CI Matrix Costs

Primary source: GitHub Actions pricing docs (`docs.github.com/en/billing/reference/actions-runner-pricing`, fetched 2026-04-16).

| Runner | Per-minute cost (post 2026-01-01 reduction) |
|---|---|
| `ubuntu-latest` (Linux 2-core) | $0.006 |
| `windows-latest` (Windows 2-core x64) | $0.010 |
| `macos-latest` | higher still |

**Effective multiplier: Windows ≈ 1.67× Linux.** (Before the 2026-01-01 ~39% price cut, the multiplier was 2× — that's the number most stale docs quote.) On top of this, GitHub introduced a flat `$0.002/min` Actions cloud-platform charge that applies to all runners including self-hosted, narrowing the relative gap for low-duration jobs but adding fixed overhead.

**Practical consequence for V1:**

- If we run the full test suite on all three OSes on every PR, Windows will consume roughly 2× the Ubuntu line-item. For a small team's CI budget this is real but not prohibitive — at ~1000 min/month of CI the marginal Windows cost is $4/month more than a Linux-only equivalent.
- The bigger cost is **time on the merge path**, not dollars: `windows-latest` cold-start and `npm install` with native deps (node-pty, @electron/rebuild) is measurably slower than Linux. Empirically across the ecosystem: Windows CI jobs that include native rebuild commonly run 1.5–3× wall-clock time of equivalent Linux jobs.
- **Flake rate on PTY tests specifically:** this is hard to cite from primary sources, but cross-referenced from VS Code's own issue tracker, node-pty's `help wanted` + `windows` + `flaky` intersection (`microsoft/node-pty#715` covers a non-Windows SIGINT flake but illustrates the category), and the Tabby incident (`Eugeny/tabby#10134` where the assertion fired on *every shutdown*). Inference: PTY shutdown tests are intrinsically flaky on Windows because teardown races with OS-level console event delivery.

**Mitigation strategies in the wild:**

- **Sharding:** VS Code shards terminal integration tests across runners and runs Windows-specific shards on dedicated runners.
- **Nightly-only Windows full suite:** keep PR CI Linux-only for the fast path, run the full Windows matrix on a scheduled nightly. Trade-off: Windows regressions land and sit for up to 24h.
- **Selective skip with explicit tracking:** tag Windows-only flakes with an issue number, skip with a timestamp, review weekly.

---

## 5. Historical Windows Rollout Pain

Evidence is anecdotal, not statistical, so I'm marking inference explicitly.

**What's well-documented:**

- VS Code's `terminal-conpty` label has persistent open issues (`#308519`, `#242891`, `#245709`, `#225719`, `#224488`) — the platform that *sets the bar* for Electron devtool polish still ships GA with known Windows terminal bugs.
- Tabby `#10134`: released a version, every user hit the assertion on close, users mass-downgraded to the prior version until fixed. **This is the most direct analog to our scenario.** The damage was reputational and non-fatal; nobody lost data.
- VS Code `#201029` and `#210792`: `Could not find pty on pty host` — a class of Windows-specific PTY host errors that recurs across releases and remote-SSH configurations.
- Node.js Windows regressions cross-pollinate: `nodejs/node#62125` (Windows detached-spawn silent termination on Node 24.13) affected node-pty lifecycle, and `microsoft/node-pty#887` is cross-referenced to it.

**The "Windows is 15% of users but 40% of issues" pattern (inference):** I did not find a primary-source cite for that exact ratio. The qualitative pattern — developer tools see disproportionate Windows bug volume driven by shell heterogeneity (cmd/pwsh/Git Bash/WSL), AV/EDR interference, path separator edge cases, and Unicode in console — is well-established in practitioner write-ups but not cleanly statistical. Do not quote the ratio as fact; **do** treat the directional claim ("Windows support load is disproportionate") as reliable.

**Antivirus / EDR interaction (primary):**

- `microsoft/vscode#239184`: SentinelOne detected Electron as a security threat. Closed, but live pattern.
- `microsoft/node-pty#887` comment thread: Windows Defender flagged `setInterval` + detached spawn as `Trojan:Win32/SuspExec.SE` (2026-04-06). **This is node-pty-adjacent code being killed by Defender behavioral detection.** Pattern: PowerShell writes a script, spawns a detached never-exiting child, parent polls liveness — indistinguishable from C2 beacon behavior. This is a category of production-grade failure mode we will inherit by shipping Windows GA.

---

## 6. Anti-patterns and Gotchas

Brief — cross-linked to Section 2 rather than re-enumerated:

- **Unicode / IME in TUI:** `microsoft/vscode#255285` (Chinese IME in `gemini cli` on Windows ConPTY) — not theoretical; we'll ship to users running Codex and Claude CLIs in the same class.
- **Ctrl+C propagation:** Windows uses `CTRL_C_EVENT` via console subsystem. `pty.kill()` only signals a single process, not the group (`microsoft/node-pty#167`). Standard workaround: `ctrlc-windows` npm package, or a synthetic console event injected into the ConPTY. Either is our problem, not node-pty's.
- **Process tree kill:** `microsoft/node-pty#437` (OPEN, Windows) — killing a node-pty process does not reliably kill its descendants. Our daemon's session-teardown semantics must assume orphans and reap via `taskkill /T`.
- **spawn locks cwd:** `microsoft/node-pty#647` — Windows holds a lock on the PTY's cwd. Breaks worktree swap if we spawn from the worktree path. Mitigation: spawn from a stable parent dir, pass the target as `env.CWD` or `cd &&`.
- **WSL2 interop:** shipping Windows GA does **not** implicitly commit us to WSL2 interop testing. The common expectation is "Windows native works, WSL2 works if user launches us from inside WSL." Electron + WSL is a known multi-year Electron-Forge pain point (no native GUI surface in WSL, X-server needed). Declaring "Windows GA means Windows native; launching from inside WSL is user-support" is the defensible scope.
- **`useConptyDll: true` pitfall:** see §2.1. Do not flip this on blind — it regresses PowerShell 7 today per `microsoft/node-pty#894`.
- **Electron shutdown race:** `microsoft/node-pty#904` SIGABRT on window close with active PTY. We must proactively kill PTYs *before* Electron's `will-quit` event, not rely on OS cleanup.

---

## 7. Options Analysis

### Option A — Windows V1 GA with Rust PTY sidecar in V1 scope

| Dimension | Notes |
|---|---|
| Upfront effort | **+3–5 engineer-weeks** beyond the `PtyHost` interface work (which happens regardless). Requires Rust build/release pipeline, cross-platform signing, IPC protocol, and a Windows integration test exercising Codex CLI under the sidecar. |
| Ongoing cost | +1 language in critical path, +3 platform binary artifacts, +1 release-signing step, +1 security-review surface. Moderate. |
| UX impact | Best for Windows users: avoids `remove_pty_baton` + `SIGABRT-on-exit` + `cwd-lock` classes. Same as macOS/Linux. |
| Risk profile | Lowers upstream dependency risk, raises own-code risk. **We trade a known bug tail we don't own for an unknown bug tail we do.** No shipping Electron devtool peer has this pattern, so we're slightly pioneering. |
| Decision gate / tripwire | A **named date** Windows PTY integration test running Codex CLI + resume, pass/fail gating sidecar inclusion. If test passes on node-pty alone by gate date, collapse to B. |

### Option B — Windows V1 GA with node-pty only, no sidecar in V1

| Dimension | Notes |
|---|---|
| Upfront effort | Minimal beyond the `PtyHost` abstraction. Document `remove_pty_baton` workaround (restart daemon on assertion, swallow dialog). |
| Ongoing cost | Low engineering, moderate support load. Every node-pty Windows bug above lands on us. |
| UX impact | Occasional visible crash dialog on Windows (baton assertion), some lost-process-tree weirdness, possible PowerShell 7 slowness if we opt into `useConptyDll`. **This is the VS Code / Cursor / Windsurf / Tabby baseline.** |
| Risk profile | Industry-norm risk. Codex-CLI-under-Windows specifically is the point where our risk diverges from VS Code's, because we're the vendor proudly promising the Codex/Claude integration rather than an opt-in terminal a user chose to open. |
| Decision gate / tripwire | Post-launch: if >5% of Windows sessions show the baton assertion in telemetry, or if Windows accounts for >40% of crash reports, pull the sidecar forward. |

### Option C — Windows V1 Beta (documented, time-boxed)

| Dimension | Notes |
|---|---|
| Upfront effort | Minimal. Add "Beta" label in installer/UI, write caveat section in docs ("Codex CLI on Windows may display a ConPTY assertion; please restart the session"). Defer sidecar to V1.1 contingency. |
| Ongoing cost | Lowest of the three: beta framing sets user expectation so support load is softer. But **ongoing brand cost:** "Beta on Windows" in a product that already chose Electron for Linux passkey parity reads as inconsistent unless framed as time-boxed. |
| UX impact | Same crash surface as Option B, but **users opted into a labeled beta** so the psychological cost of each incident is lower. |
| Risk profile | Cheapest technical risk, moderate brand risk. Exits cleanly to GA in V1.1 via either (a) upstream node-pty fix or (b) our sidecar. |
| Decision gate / tripwire | Exit beta when: node-pty v1.2.0 stable ships with the baton-class race fixed, **or** our PTY integration test passes 50 consecutive runs on `windows-latest` without assertion, **or** we ship the Rust sidecar. First of the three. |

### Additional option surfaced by research

**Option D — GA on `useConptyDll: true` + fallback.** Use node-pty's bundled ConPTY DLL to skip the system-version dance, with runtime fallback to system ConPTY if the new path shows the PowerShell-7 delay (`#894`). Cheaper than a sidecar, closer to what Windows Terminal and WezTerm do.

- **Why it's attractive:** no Rust, no new language, no sidecar IPC; gets ConPTY v2 features today; addresses some (not all) of the bug classes.
- **Why it's not a full answer:** `#894` is open and unfixed; PowerShell 7 is the default pwsh — we'd ship a visible regression for a common shell. And the `remove_pty_baton` + ThreadSafeFunction race are inside node-pty itself, not ConPTY, so bundled ConPTY doesn't fix the trigger. Treat D as a **flag to combine with B or C** (enable `useConptyDll` after `#894` closes, or behind a feature flag), not a standalone option.

---

## 8. Recommendation

### Pick: **Option C — Windows V1 Beta**, with a written sidecar contingency.

**Exec-level argument:**

1. The **industry norm for this class of app is Option B** (VS Code, Cursor, Windsurf, Tabby, Wave, Claude Code). B is the defensible middle. That means the argument against C is "you're being more conservative than peers."
2. The **specific constraint that tips us away from B** is: our first-party, top-of-marketing integration is Codex CLI on Windows, which has a *currently-live* ConPTY assertion (`openai/codex#13973`) and *no upstream-triaged fix* in `microsoft/node-pty` as of research date. The Tabby incident (`Eugeny/tabby#10134`) is the direct precedent — a GA ship on this bug class caused a user-visible rollback wave. Tabby users' escape hatch was downgrading Tabby. Our users' escape hatch would be either not using Codex on Windows or rolling back to V0. That is a weaker product story than "Windows is in beta; Codex-on-Windows is known-beta; here's the workaround."
3. The **argument against A (sidecar in V1)** is that we'd ship V1 with a novel pattern (Rust PTY sidecar for Electron/Node devtools) that has no shipping peer precedent in our niche. Wave ships a Go sidecar, but that's only relevant if Go is already in our stack — it isn't. We'd be paying 3–5 engineer-weeks and a new language's ongoing cost to solve a problem we can also solve by *waiting* for a 1–2 quarter upstream fix cycle or a `PtyHost` swap in V1.1.
4. **C preserves optionality.** The `PtyHost` interface is in place regardless; V1.1 can land either the Rust sidecar (if upstream is still broken) or a straight node-pty upgrade (if `v1.2.0` ships with the fix) — the choice is made with 3–6 more months of data.

### Steel-man of the strongest alternative (Option A)

"Windows is 25–35% of the US pro-dev population. Shipping anything less than GA there signals that we're not a first-class Windows citizen. The industry norm is B because VS Code has 10+ years of Windows terminal engineering absorbed into it; we don't. If we can't be B, we should over-invest to *become* B, and the sidecar is the tool. 3–5 weeks is cheap insurance against the scenario where `codex#13973` spreads in the wild and every Windows user of ours hits it during `/resume`. The Tabby story is exactly why we should *not* be in beta on Windows — Tabby ate the reputational cost and still had to pin node-pty; we'd take the same hit on a bigger launch."

**Why I don't pick A:** the 3–5 engineer-weeks is real, our V1 scope is already 16 features, and no shipping Electron devtool peer has paid this cost for *this specific* failure mode. If the bug were already reproducing at 50% of Windows sessions, A would be right. At *n=2* GitHub reporters over six weeks, A is over-investment. The `PtyHost` interface bought us the right to defer.

### Tripwires — measurable post-launch events that flip the decision

Flip from C to A (pull sidecar forward into V1.x) if **any** of these fires:

1. **Crash telemetry:** >5% of Windows daemon sessions emit a ConPTY assertion or SIGABRT during a rolling 7-day window.
2. **Support share:** Windows accounts for >40% of P1/P2 crash tickets for three consecutive weeks, against an estimated <30% Windows MAU share.
3. **Upstream stagnation:** `microsoft/node-pty` stable v1.2.0 has not shipped by **2026-09-01**, AND a new `baton`/ThreadSafeFunction-class upstream issue is open without maintainer-claimed owner.

Flip from C to B (drop the beta label without adding the sidecar) if **all** of these hold:

1. `microsoft/node-pty` ships stable v1.2.0 with the ThreadSafeFunction cleanup fixed (watch `#904`).
2. Our Windows CI matrix (Codex CLI + `/resume` + node-pty) passes 50 consecutive `windows-latest` runs without the assertion.
3. Zero Sev-1 Windows PTY support tickets in the preceding 30 days.

### Revisit cadence

Monthly during V1 ramp; quarterly after GA announcement. Owner: Windows-tier decision goes to the person owning the `PtyHost` interface.

---

## 9. Sources

Primary sources cited inline. Consolidated list, all fetched 2026-04-16.

**Trigger and related upstream:**
- openai/codex#13973 — `Assertion failed in node-pty conpty.cc line 106: remove_pty_baton(baton->id)` — `https://github.com/openai/codex/issues/13973`
- microsoft/node-pty#904 — `SIGABRT crash during Electron process exit (ThreadSafeFunction cleanup race)` — `https://github.com/microsoft/node-pty/issues/904`
- microsoft/node-pty#887 — `Windows: ConoutConnection worker thread prevents Node.js from exiting after kill()` — `https://github.com/microsoft/node-pty/issues/887`
- microsoft/node-pty#894 — `Severe output delay (~3.5s) when using useConptyDll: true with PowerShell 7` — `https://github.com/microsoft/node-pty/issues/894`
- microsoft/node-pty#827 — `Windows crash on Node.js v22 – "Cannot resize a pty that has already exited"` — `https://github.com/microsoft/node-pty/issues/827`
- microsoft/node-pty#437 — `Unable to kill pty process on Windows` — `https://github.com/microsoft/node-pty/issues/437`
- microsoft/node-pty#647 — `spawn locks cwd on Windows` — `https://github.com/microsoft/node-pty/issues/647`
- microsoft/node-pty#167 — `Sending a signal to all processes in the processgroup of the pts` — `https://github.com/microsoft/node-pty/issues/167`
- microsoft/node-pty#842 — `Remove winpty support` — `https://github.com/microsoft/node-pty/issues/842`
- microsoft/node-pty releases — `https://github.com/microsoft/node-pty/releases`

**Reference apps and ConPTY landscape:**
- Eugeny/tabby#10134 — `"Assertion failed!" when closing the tabby window on Windows 11` — `https://github.com/Eugeny/tabby/issues/10134`
- microsoft/vscode#224488 — `Ship newer version of conpty` — `https://github.com/microsoft/vscode/issues/224488`
- microsoft/vscode#242891 — `Killing tasks does not actually kill them` (Windows) — `https://github.com/microsoft/vscode/issues/242891`
- microsoft/vscode#245709 — `conpty assertion failure on new window` — `https://github.com/microsoft/vscode/issues/245709`
- microsoft/vscode#308519 — `Integrated terminal duplicates output after switching VS Code windows` — `https://github.com/microsoft/vscode/issues/308519`
- microsoft/vscode#255285 — `Terminal viewport shifts left with Chinese IME in specific TUI (gemini cli) apps on Windows with ConPTY` — `https://github.com/microsoft/vscode/issues/255285`
- microsoft/vscode#252489 — `Terminal commands are not reliable when conpty dll is false` — `https://github.com/microsoft/vscode/issues/252489`
- microsoft/vscode#239184 — `SentinelOne detect a security threat with Electron` — `https://github.com/microsoft/vscode/issues/239184`
- microsoft/vscode#201029 — `[Remote-SSH Bug]: Error: AttachConsole failed, could not find pty on pty host` — `https://github.com/microsoft/vscode/issues/201029`
- microsoft/terminal discussion #19112 — `ConPTY Version probing` — `https://github.com/microsoft/terminal/discussions/19112`
- Zed — `Windows When? Windows Now` blog — `https://zed.dev/blog/zed-for-windows-is-here`
- Zed terminal core docs — `https://deepwiki.com/zed-industries/zed/9.1-terminal-core`
- Warp terminal (Rust forum announcement) — `https://users.rust-lang.org/t/warp-terminal-is-now-on-windows/126290`
- Wave Terminal (wavetermdev/waveterm) — `https://github.com/wavetermdev/waveterm`
- anthropics/claude-code — `https://github.com/anthropics/claude-code`

**PTY alternatives (Rust / Go):**
- portable-pty on crates.io — `https://crates.io/crates/portable-pty`
- wezterm/pty source tree — `https://github.com/wezterm/wezterm/tree/main/pty`
- aymanbagabas/go-pty — `https://github.com/aymanbagabas/go-pty`
- creack/pty (Windows ConPTY history: PRs #109, #155; issues #95, #169) — `https://github.com/creack/pty`
- winpty-rs — `https://github.com/andfoy/winpty-rs`
- @homebridge/node-pty-prebuilt-multiarch — `https://github.com/homebridge/node-pty-prebuilt-multiarch`

**Build, signing, CI cost:**
- GitHub Actions runner pricing — `https://docs.github.com/en/billing/reference/actions-runner-pricing`
- GitHub 2026 Actions pricing changes — `https://github.com/resources/insights/2026-pricing-changes-for-github-actions`
- Tauri sidecar docs (v2) — `https://v2.tauri.app/develop/sidecar/`
- Electron code-signing — `https://www.electronjs.org/docs/latest/tutorial/code-signing`
- Azure Trusted Signing / SmartScreen context — Security Boulevard 2025-12 — `https://securityboulevard.com/2025/12/how-to-sign-a-windows-app-with-electron-builder/`

**Cross-cut / Node.js upstream:**
- nodejs/node#62125 (Windows detached-spawn silent termination on Node 24.13, cross-referenced from node-pty#887).

*End of brief.*
