# ADR-016: Electron Desktop Shell

| Field         | Value                           |
| ------------- | ------------------------------- |
| **Status**    | `accepted`                      |
| **Type**      | `Type 2 (one-way door)`         |
| **Domain**    | `Desktop / Client Architecture` |
| **Date**      | `2026-04-17`                    |
| **Author(s)** | `Claude (AI-assisted)`          |
| **Reviewers** | `Accepted 2026-04-17`           |

## Context

The product ships a cross-platform desktop application alongside a CLI as part of V1 (ADR-015 lists Desktop GUI as feature 15). The desktop app renders a React + Vite UI, supervises the local daemon, handles native dialogs, implements auto-update, and hosts the preload bridge that sits between the renderer and the trusted main process (per `container-architecture.md`). ADR-010 names WebAuthn PRF as the primary desktop authentication mechanism for credential wrapping and relay session bootstrap.

The pre-implementation architecture audit (session `2026-04-16-arch-audit-163537`) evaluated Electron, Tauri 2.x, and Wails v3 as desktop shell options. No desktop shell code exists. This ADR is the forward declaration of the V1 shell choice so Plan-023 (desktop shell implementation, from BL-043) can begin against a decided target.

## Problem Statement

What desktop shell should host the React + Vite renderer, supervise the local daemon, and host the preload bridge across Windows, macOS, and Linux, given that WebAuthn is the primary desktop credential mechanism?

### Trigger

ADR-010 commits to WebAuthn PRF as the primary desktop credential path, which turns the shell choice into a question about renderer-engine WebAuthn support across all three target platforms. The audit identified one option (Electron) where that support is uniform, and two options (Tauri, Wails) where it is not. V1 ship requires the question closed before Plan-023 starts scaffolding.

## Decision

Electron is the V1 desktop shell. **Amended 2026-09-01 (console-design swap, [cross-plan-dependencies.md §6](../architecture/cross-plan-dependencies.md) node NS-97):** the supported branches are now **42, 43, and 44** — Electron 41 reached end-of-support on 2026-08-25 with the 44.0.0 release per the [Electron 44 release post](https://www.electronjs.org/blog/electron-44-0) — and V1 targets **44.x** (44.1.1 at amendment). Every release on those three branches post-dates the GHSA-3c8v-cfp5-9885 fixed versions (42.0.0 GA 2026-05-05), so the floor below is satisfied by construction on any supported branch; the amended rule is two-part: (i) V1 builds run on **44.x only** — the console's `browser` pane kind depends on the detached-`WebContentsView` bounds fix (electron/electron PR #53031), which landed on 44 and reached 42 / 43 only as late backports, so an earlier 42.x or 43.x point release clears the CVE floor and still lacks the fix, and rather than carry a per-branch fix floor this ADR cannot verify from the release feed it admits one branch; (ii) any build tooling or supervisor that would select a release on an end-of-life branch, or on 42 / 43 at all for a V1 build, is non-conformant. 42 and 43 stay in the supported-branch subset as the CVE-floor derivation record, not as admissible V1 runtimes. The sentence that follows is the 2026-04-17 floor, retained as the derivation record. The minimum supported Electron stable-branch floor was **≥ 39.8.1 on branch 39, ≥ 40.8.1 on branch 40, and ≥ 41.0.0 on branch 41** — the supported-branches subset of the fixed-version floors published in [GHSA-3c8v-cfp5-9885](https://github.com/electron/electron/security/advisories/GHSA-3c8v-cfp5-9885) for [CVE-2026-34776](https://nvd.nist.gov/vuln/detail/CVE-2026-34776), an out-of-bounds heap read in the `requestSingleInstanceLock()` second-instance IPC message parser on macOS and Linux (Windows is unaffected by this advisory). GHSA-3c8v-cfp5-9885 additionally lists ≥ 38.8.6 on branch 38; branch 38 reached end-of-life on 2026-03-10 per the Electron release timeline (see Assumption 3) and is therefore excluded from the V1-target enumeration — listed here for completeness of the fix-floor record only. Any Electron release on a supported branch must meet or exceed the floor above; any build tooling or supervisor that would select a release below this floor is non-conformant. The Electron main process supervises the local daemon, handles native dialogs and auto-update via `electron-updater`, and hosts the preload bridge. The renderer runs React + Vite under Chromium on all three target platforms.

### Thesis — Why This Option

1. **WebAuthn works uniformly on Chromium.** Electron bundles Chromium on Windows, macOS, and Linux; the WebAuthn API surface (including the PRF extension) is carried by the same engine on all three, where the WebKitGTK-based alternatives carry none. _Narrowed 2026-09-01 (§6 node NS-99): the closing clause of this point previously read "works without per-platform branching", and that is false — Chromium's origin allowlist refuses public-key credentials on this app's custom renderer scheme, and Chromium ships platform-authenticator backends for macOS and Windows but none for Linux, so `Spec-023 §WebAuthn Platform-Authenticator Native Module` branches per platform in the main process. Re-derived again 2026-09-01 (Codex round 2): with every ceremony now shell-native, this point no longer distinguishes Electron from Tauri or Wails at all — a Rust or Go host binds the same three OS surfaces — so it is struck from the deciding set and the constraints that still decide are enumerated in §Decision Log._
2. **Single rendering engine, not three.** Tauri and Wails use the OS-native webview — WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux — which triples the rendering-behavior QA matrix. Electron's uniform Chromium means the renderer behaves the same on all three OSes.
3. **Mature cross-platform delivery ecosystem.** `electron-builder` + `electron-updater` + established code-signing pipelines (Apple Developer ID, Windows Authenticode, Linux repository packaging) ship production desktop apps at scale today. VS Code, Slack, Discord, Teams, Notion Desktop, 1Password (pre-8), and Figma Desktop all ship on Electron with large production footprints.
4. **Ecosystem alignment with the product's TypeScript-native stack.** The main process is Node.js; all first-party code (daemon, CLI, control plane) is TypeScript; no language-in-critical-path cost is added. The preload-bridge trust model (`container-architecture.md` §Trust Boundaries; renderer untrusted, shell trusted, daemon trusted) maps cleanly onto Electron's `contextBridge` API.

### Antithesis — The Strongest Case Against

Modern desktop users expect lightweight apps, and Electron's ~100 MB baseline bundle and heavy memory footprint (often 200–400 MB resident with a single window open) are the opposite of that. Tauri 2.x ships ~3 MB base bundles with an order-of-magnitude smaller memory footprint because it uses the OS-native webview rather than bundling Chromium. For a greenfield project making a decade-scale foundation commitment, starting with the modern lightweight option rather than the older heavy option is the default-correct choice. Rust brings memory safety, strong performance guarantees, and a clean tooling chain (cargo). Several high-profile projects have shipped on Tauri (1Password 8) or are evaluating migration from Electron. The cost-benefit looks like a clear Tauri win absent a specific blocker.

### Synthesis — Why It Still Holds

The antithesis wins on bundle size and baseline memory and loses on the renderer, not on the authenticator. _Re-derived 2026-09-01 (Codex round 2)._ This section previously rested on "the one constraint that cannot be engineered around" — WebKitGTK has no WebAuthn support, and WebKitGTK is the renderer Tauri and Wails use on Linux. That sentence is now **false, and this corpus is what falsified it**: `Spec-023 §WebAuthn Platform-Authenticator Native Module` drives every ceremony from the main process through per-platform native bindings, which a Rust or Go host could bind equally well, so the constraint was engineered around and no longer decides. What decides is enumerated in §Decision Log and is unchanged by that: one Chromium renderer carrying single-number console budgets and one terminal tier, an in-process `WebContentsView` with a CDP channel for the `browser` pane on all three platforms, a Node main process forking the daemon as a `utilityProcess` child, and the reversal cost of shipped code already bound to the Electron main API. Bundle size is addressed by asar packaging and by the fact that the target user already has VS Code or JetBrains installed (comparable footprint). Memory footprint is within the daemon-plus-shell budget named in `deployment-topology.md`. The QA-matrix concern the antithesis understates is exactly what has driven production teams to migrate _to_ Electron from native-webview shells; behavioral drift across WKWebView / WebView2 / WebKitGTK scales test costs with platform count. Electron's uniform Chromium scales test costs with feature count only.

## Alternatives Considered

### Option A: Electron (Chosen)

- **What:** Chromium renderer with a Node.js main process, `contextBridge` preload, `electron-updater` for delta-patch auto-update, `electron-builder` for packaging and code-signing.
- **Steel man:** Uniform Chromium renderer on all three platforms — one set of console budget numbers, one terminal tier, and one `WebContentsView` + CDP path for the embedded-browser pane; a Node main process that forks the daemon as a `utilityProcess` child (re-derived 2026-09-01, Codex round 2 — the former WebAuthn-engine clause is struck from the deciding set; see §Decision Log); mature ecosystem (VS Code, Slack, Discord, Teams, Notion, Figma Desktop); TypeScript-native main process aligns with the rest of the stack; preload-bridge model maps to the renderer-untrusted trust boundary.
- **Weaknesses:** 100 MB+ baseline bundle; 200–400 MB resident memory under single-window load; Chromium security-patch cadence tied to Electron release cadence; Node.js in the main process expands the attack surface vs a Rust or Go host.

### Option B: Tauri 2.x (Rejected)

- **What:** Rust main process, OS-native webview on each platform (WKWebView macOS, WebView2 Windows, WebKitGTK Linux), TypeScript/React renderer.
- **Steel man:** ~3 MB base bundle; ~10× lower baseline memory; memory-safe Rust host; clean `cargo` tooling chain; 1Password 8 production precedent; Tauri v2 stable. For a greenfield decade-scale commitment, the lightweight modern option is the default-correct choice absent a specific blocker.
- **Why rejected:**
  1. **Withdrawn as a rejection reason 2026-09-01 (Codex round 2).** This point read "WebKitGTK has no WebAuthn support in 2026, and no upstream signal suggests it is close to landing"; the premise is still true and no longer decides: `Spec-023 §WebAuthn Platform-Authenticator Native Module` runs every ceremony from the main process over `AuthenticationServices` / `webauthn.dll` / `libfido2`, and a Rust host can bind those three surfaces as readily as a Node one. The rejection now rests on points 2 and 3 plus the console constraints enumerated in §Decision Log — the single-number budgets, the terminal tier, and the `WebContentsView` + CDP requirement of the `browser` pane, which WKWebView / WebView2 / WebKitGTK meet with neither one API nor one protocol.
  2. Triple-webview behavior drift (WKWebView vs WebView2 vs WebKitGTK) turns every renderer-behavior test into three tests. This is a documented migration driver for production teams moving from native-webview shells to Chromium-based shells.
  3. Rust in the main process adds a language-in-critical-path cost to a TypeScript-native team for no offsetting benefit that the WebAuthn constraint doesn't already wipe out.

### Option C: Wails v3 (Rejected)

- **What:** Go main process, OS-native webview (same engines as Tauri on each platform), Go→JS bindings.
- **Steel man:** Similar bundle-size and memory benefits to Tauri; Go ergonomics for backend-familiar developers; simpler build chain than Rust.
- **Why rejected:**
  1. Same WebKitGTK position as Tauri, and the same withdrawal: the WebAuthn gap no longer decides (2026-09-01, Codex round 2 — see Option B point 1), while the triple-webview console constraints in §Decision Log apply identically.
  2. Wails v3 is in alpha as of 2026-04; no flagship production apps ship on v3. A desktop shell is a decade-scale foundation commitment; building on alpha tooling is insufficient risk management.
  3. Team is TypeScript-native, not Go-native; introduces language-in-critical-path cost without the offsetting team-expertise benefit that would justify it.

### Option D: Native per-platform shells (Rejected)

- **What:** SwiftUI on macOS, WinUI on Windows, GTK or Qt on Linux.
- **Steel man:** Best native UX on each platform; true zero-overhead baseline footprint; full access to per-platform capabilities.
- **Why rejected:** Triples implementation effort; no shared UI code across platforms; breaks the shared-SDK-between-CLI-and-desktop pattern the vision establishes; V1 timeline cannot absorb three parallel native shell implementations.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | WebKitGTK's WebAuthn support remains absent through the V1 launch window. | WebKit2GTK as of 2026-04 has no WebAuthn implementation in any public branch; WebKitGTK is downstream of WebKit and typically lags; no upstream signal of WebAuthn landing. | Nothing in the deciding set moves — re-derived 2026-09-01 (Codex round 2): the WebAuthn constraint was struck when the ceremony went shell-native, so this assumption is now a monitoring row rather than a load-bearing one, and Tripwire 1 fires for revisit on the console constraints instead. |
| 2 | Electron tracks Chromium security patches within 1–2 weeks of Chromium stable releases. | Electron has consistently met this cadence in 2025–2026 release history; Electron maintains a documented patch SLA across its supported stable branches. | We would need to monitor Chromium CVE feeds ourselves, or move to Chromium-Embedded-Framework directly, or swap shells. |
| 3 | Electron's supported stable branches continue to publish point releases at or above the §Decision floor (≥ 39.8.1 / 40.8.1 / 41.0.0 on branches 39 / 40 / 41, with branch 38 EOL 2026-03-10 and excluded as a V1 target). **Re-derived 2026-09-01:** the supported branches are 42 / 43 / 44 (41 EOL 2026-08-25; 42 EOL 2026-10-20, 43 EOL 2027-01-05, 44 EOL 2027-03-02 per endoflife.date), every release on them post-dates the fixed versions, and the V1 target is 44.x only — the 42 / 43 backport points of the bounds fix are not carried, so those branches are supported by upstream but not admissible V1 runtimes. | Current stable heads as of 2026-04-17 were 41.2.1, 40.9.1, 39.8.8 — all above the floor per [releases.electronjs.org](https://releases.electronjs.org/); as of 2026-09-01 the head is 44.1.1. Electron supports the latest three stable branches per [electron/electron release timeline](https://www.electronjs.org/docs/latest/tutorial/electron-timelines). | A supported branch falls out of compliance (EOL before reaching the floor, or a regression ships below it) — that branch is ineligible for distribution and the build supervisor must select a different supported branch or fail closed. |
| 4 | `electron-updater` delta-patch flow is reliable across Windows, macOS, Linux. | Proven at scale by VS Code, 1Password (pre-8), Slack, and others. | Larger update payloads; ongoing bandwidth cost; user-visible update-time regression. |
| 5 | The ~100 MB baseline bundle is acceptable to our target developer audience. | VS Code (~100 MB) and JetBrains IDEs (500 MB+) receive no material user pushback on install size. Our target user already has similar-footprint tools installed. | Competitive pressure from a lightweight alternative with feature parity; Tripwire 4 fires. |

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Electron security-patch cadence slips; Chromium CVE unpatched for weeks | Low | High | Automated release-tracking; Chromium CVE feed monitoring | Manual Chromium-patch integration on a maintenance branch; evaluate alternative shells |
| Chromium memory-footprint regression under load | Med | Med | Runtime memory metrics via observability; daemon memory-budget alerts | Renderer-process isolation; lazy-load non-critical panels |
| WebKitGTK adds WebAuthn support (reversal trigger) | Low | Low (positive signal) | WebKit release-note monitoring | Not a forcing failure; evaluate Tauri revisit window per Tripwire 1 |
| Team gains Rust-comfortable engineer with bandwidth (reversal trigger) | Low | Low (positive signal) | Team-composition change | Not a forcing failure; evaluate Tauri revisit window per Tripwire 2 |
| Electron removes or breaks the `contextBridge` preload model | Low | High | Electron release notes; contract conformance tests | Pin to previous Electron major; migrate to alternative shell |
| electron-updater signing pipeline breaks on code-signing-cert rotation | Low | Med | CI signing tests; cert-expiry monitoring | Standby cert; documented rotation runbook |

## Reversibility Assessment

- **Reversal cost:** Very high once V1 desktop ships. Desktop shell migration touches every renderer-to-shell IPC surface, packaging pipeline, auto-update mechanism, code-signing certificate chain, install-tool UX, and native-dialog integration. Multi-month migration under realistic assumptions.
- **Blast radius:** `apps/desktop/src/main/`, `apps/desktop/src/renderer/`, preload bridge contracts, auto-update infrastructure, signed-release pipeline, user-install tooling, every user with an installed version of the prior shell.
- **Migration path:** Build a parallel shell target under a new package; migrate renderer code (React + Vite is shell-agnostic); migrate preload bridge to new shell's equivalent; migrate auto-update; cut over in a major version with a deprecation window for the previous shell.
- **Point of no return:** First V1 desktop release ships to users. Before that milestone, reversal is implementation-cost only, not user-migration cost.

## Consequences

### Positive

- The renderer engine carries WebAuthn PRF on all three platforms, which is the comparison that decided against the WebKitGTK-based options — WebKitGTK carries none. _Narrowed 2026-09-01 (§6 node NS-99): this is an **engine** claim and was never a claim that one code path serves all three hosts. Chromium's origin allowlist refuses public-key credentials on the app's custom renderer scheme, and Chromium ships platform-authenticator backends for macOS and Windows and none for Linux, so `Spec-023 §WebAuthn Platform-Authenticator Native Module` drives the ceremony from the main process through a per-platform native binding — native on all three, uniform on none. Re-derived again 2026-09-01 (Codex round 2): with the ceremony shell-native this bullet is no longer a **reason** for the decision at all — it records a property the chosen shell happens to have. The reasons that survive are listed in §Decision Log._
- Renderer QA matrix scales with feature count, not with platform count.
- Mature `electron-updater` auto-update pipeline reduces custom infrastructure work.
- TypeScript-native main process aligns with daemon, CLI, and control-plane language choice; no cross-language critical-path cost.

### Negative (accepted trade-offs)

- ~100 MB baseline bundle; accepted because target developer users already have comparable-or-larger IDE installs.
- Higher resident memory than Tauri/Wails; within the capacity budget named in `deployment-topology.md`.
- Node.js in the main process expands attack surface vs a Rust/Go host; mitigated by the renderer-untrusted preload-bridge trust model from `container-architecture.md`.
- Desktop security-patch cadence is coupled to Electron's upstream cadence; Electron has a reliable track record but is a non-zero dependency risk.

### Unknowns

- Exact V1 desktop bundle size under asar + production optimizations — to be measured in Plan-023 CI once shell scaffolding lands.

## Decision Validation

### Pre-Implementation Checklist

- [x] All unvalidated assumptions have a validation plan (Plan-023 CI covers Assumptions 3 and 4; ongoing monitoring covers 1, 2, 5)
- [x] At least one alternative was seriously considered and steel-manned (Tauri 2.x and Wails v3 both steel-manned)
- [x] Antithesis was reviewed (written in Thesis/Antithesis/Synthesis triad; reviewed at ADR acceptance)
- [x] Failure modes have detection mechanisms
- [x] Point of no return is identified and communicated to the team

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| WebAuthn passkey flow works on Windows, macOS, Linux | 100% of tested platforms, against the authenticator class each platform offers — a platform authenticator on macOS and Windows, a roaming FIDO2 key on Linux (re-derived 2026-09-01, §6 node NS-99) | Plan-023 integration test suite, plus the recorded manual PRF matrix no hosted runner can produce | `2026-09-01` |
| Desktop bundle size (post-asar, post-compression) | < 150 MB | CI artifact size check | `2026-08-01` |
| Auto-update delta patches ship | Delta install < 30% of full bundle | `electron-updater` release test | `2026-09-01` |
| Renderer-to-main IPC conformance with ADR-009 | 100% of IPC uses Content-Length JSON-RPC | Contract test suite | `2026-08-01` |

### Revisit Triggers

1. A native-webview shell can meet the console constraints in §Decision Log — one set of budget numbers, one terminal tier, and an in-process browser view with a CDP channel on all three platforms — evaluate a Tauri re-assessment window if bundle-size pressure has materialized. _Re-derived 2026-09-01 (Codex round 2): this trigger previously read "WebKitGTK ships WebAuthn support in a stable release", which no longer bears on the decision now that the ceremony is shell-native._
2. Team gains a Rust-comfortable engineer with bandwidth to own a migration — evaluate Tauri re-assessment window with team composition supporting the Rust learning curve.
3. Electron drops or materially changes the `contextBridge` preload model — evaluate alternative shells regardless of other factors.
4. Desktop bundle size or memory footprint becomes a primary user complaint in production telemetry at measurable rate — investigate shell alternatives rather than optimizing within Electron.

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Electron releases | Documentation | Chromium security-patch SLA, preload bridge stability | <https://www.electronjs.org/releases> |
| Electron release timeline | Documentation | "Latest three stable branches" support policy; current stable heads 41.2.1 / 40.9.1 / 39.8.8 as of 2026-04-17 | <https://www.electronjs.org/docs/latest/tutorial/electron-timelines> |
| Electron 44 release post + releases feed | Changelog + registry (2026-09-01 amendment) | 44.0.0 released 2026-08-25 (Chromium 152.0.7977.54 / Node 24.18.1) and Electron 41.x end-of-support declared in the same post; 44.1.1 published 2026-09-01; supported majors 44 / 43 / 42 | <https://www.electronjs.org/blog/electron-44-0> |
| GHSA-3c8v-cfp5-9885 | Security advisory (primary) | Fixed-version floors 38.8.6 / 39.8.1 / 40.8.1 / 41.0.0 for the `requestSingleInstanceLock()` second-instance IPC parser out-of-bounds heap read on macOS and Linux (Windows unaffected) | <https://github.com/electron/electron/security/advisories/GHSA-3c8v-cfp5-9885> |
| NVD CVE-2026-34776 | CVE record (primary) | CWE-125 out-of-bounds read; CVSS 3.1 base 5.3 (vector `AV:L/AC:H/PR:L/UI:N/S:U/C:H/I:N/A:L`) | <https://nvd.nist.gov/vuln/detail/CVE-2026-34776> |
| WebKitGTK project site | Documentation | No WebAuthn implementation noted across project releases as of 2026-04 | <https://webkitgtk.org/> |
| Tauri v2 documentation | Documentation | OS-native webview strategy; WebKitGTK on Linux | <https://v2.tauri.app/> |
| Wails v3 status page | Documentation | v3 alpha status; no flagship production apps | <https://wails.io/> |
| Pre-implementation audit | Primary research | Evaluated Electron, Tauri, Wails; recommended Electron | session `2026-04-16-arch-audit-163537` |

### Related ADRs

- [ADR-010: PASETO + WebAuthn + MLS Auth](./010-paseto-webauthn-mls-auth.md) — establishes the WebAuthn dependency that blocks WebKitGTK-based shells on Linux.
- [ADR-009: JSON-RPC IPC Wire Format](./009-json-rpc-ipc-wire-format.md) — the IPC wire format the preload bridge reuses between renderer and main.
- [ADR-015: V1 Feature Scope Definition](./015-v1-feature-scope-definition.md) — names Desktop GUI as a V1 feature; this ADR enables it.

### Related Docs

- [Container Architecture](../architecture/container-architecture.md) — renderer-untrusted / shell-trusted / daemon-trusted trust model that this ADR implements.
- [Component Architecture: Desktop App](../architecture/component-architecture-desktop-app.md) — desktop-specific component decomposition.
- [Vision §Technology Position](../vision.md#technology-position) — Electron named as the desktop shell in the Keep section.

## Decision Log

| Date | Event | Notes |
| --- | --- | --- |
| 2026-04-17 | Proposed | Drafted against BL-040 exit criteria |
| 2026-04-17 | Accepted | ADR accepted as the V1 desktop shell decision |
| 2026-09-01 | Floor amended | Supported-branch subset moved from 39 / 40 / 41 to **42 / 43 / 44** and the V1 target set to **44.x**, on Electron 41's end-of-support (2026-08-25, with 44.0.0) and on the console's `browser` pane kind needing the detached-`WebContentsView` bounds fix backported to 42+ only (electron/electron PR #53031); V1 admits 44.x alone, since the fix reached 42 / 43 only as late backports and a per-branch fix floor is not carried (Codex round 1). Assumption 3 re-derived. Carried by the console-design amendment to [Spec-023](../specs/023-desktop-shell-and-renderer.md) / [Plan-023](../plans/023-desktop-shell-and-renderer.md) ([cross-plan-dependencies.md §6](../architecture/cross-plan-dependencies.md) node NS-97); Status stays `accepted` — the decision (Electron) is unchanged, only its version envelope moves. |
| 2026-09-01 | Consequence narrowed; deciding set re-derived | Three claims are narrowed and one criterion re-derived: the §Thesis point-1 clause "works without per-platform branching", the §Consequences positive bullet claiming WebAuthn PRF works **uniformly** across the three platforms, and the §Alternatives Option A steel-man clause "WebAuthn supported uniformly" all narrow to the engine claim they always were, and the §Success Criteria row is re-derived onto the authenticator class each platform actually offers. Chromium's origin allowlist refuses public-key credentials on the app's custom renderer scheme (measured on Electron 44.1.1: the scheme is a secure context and is refused anyway), and Chromium ships no Linux platform-authenticator backend, so `Spec-023 §WebAuthn Platform-Authenticator Native Module` drives the ceremony from the main process through a per-platform native binding — an own-built `AuthenticationServices` addon on macOS, `webauthn.dll` on Windows, `libfido2` on Linux. **The deciding set is re-derived, not restated (Codex round 2).** The prior wording here held Status at `accepted` on the ground that "WebKitGTK carries no engine-level WebAuthn at all", and that is no longer an honest ground: once every ceremony runs shell-native over `AuthenticationServices` / `webauthn.dll` / `libfido2`, the renderer engine's WebAuthn support decides nothing, because a Rust or Go host binds those same three OS surfaces. The WebAuthn constraint is therefore **struck from the deciding set**, §Synthesis's "the one constraint that cannot be engineered around" is corrected in the same edit — this amendment _is_ the engineering-around — and the constraints that still decide are listed with their evidence rather than asserted. **(1) One Chromium renderer on all three OSes.** `Spec-023 §Console Design (Meridian)` §Budgets are single-number targets — ≤ 450 kB gzip initial bundle, p95 ≤ 16.7 ms frame time with four lanes streaming, ≤ 120 MB renderer heap at rest, ≤ 20 MiB per terminal instance — measured against the built bundle running in the Electron shell, and the `@xterm/xterm` 6.0.0 WebGL terminal tier is specified against Chromium's sixteen-context ceiling and its `onContextLoss` behavior (`Spec-023 §Console Libraries`). A native-webview shell needs three numbers per budget and three terminal tiers, which is a different product. **(2) The `browser` pane kind.** It is a main-process `WebContentsView` hosted beside the renderer with a `devtools-protocol`-typed `webContents.debugger` channel (`Spec-023 §Console Libraries`, the native-browser-view row; `Spec-023 §Console Design (Meridian)` §The surface set). WKWebView, WebView2, and WebKitGTK expose neither one embedding API nor one debugging protocol across the three platforms. **(3) `utilityProcess` over a Node main process.** The shell forks the daemon as a Chromium-Services child rather than a `child_process` (`Spec-023 §Utility Process Vs Child Process`), and that daemon is the Node host for the `better-sqlite3` binding pinned to this runtime's Node-API line and the supervisor of the Rust PTY sidecar. A Rust or Go host makes the daemon an out-of-band external process and re-opens supervision, ABI pinning, and shutdown ordering — the case §Open Questions already names as the trigger to replace this ADR's supervision guidance. **(4) Reversal cost against shipped code.** Tier-1 desktop code already in `develop` binds the Electron main API directly — `app` and `BrowserWindow` in `main/index.ts`, `BrowserWindow` in `main/window.ts`, `contextBridge` in `preload/index.ts`, and the `App` type in `main/sidecar-lifecycle.ts` — and Plan-023's authored Phase 1B / 1C build on `protocol.registerSchemesAsPrivileged` and `net.fetch`, for which the native-webview shells offer no equivalent (§Reversibility Assessment). **Status outcome, stated rather than assumed: the remaining set still decides, so Status stays `accepted`.** Items (1) and (2) are each independently sufficient against a native-webview shell and (3) and (4) raise the reversal cost §Reversibility Assessment already grades Very high; had the set emptied, this row would have moved the ADR to `proposed` for re-decision instead of recording a narrowing. See [cross-plan-dependencies.md §6](../architecture/cross-plan-dependencies.md) node NS-99. |
