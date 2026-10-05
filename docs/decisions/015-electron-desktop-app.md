# ADR-015: Electron Desktop App

| Field         | Value                           |
| ------------- | ------------------------------- |
| **Status**    | `accepted`                      |
| **Type**      | `Type 2 (one-way door)`         |
| **Domain**    | `Desktop / Client Architecture` |
| **Date**      | `2026-04-17`                    |
| **Author(s)** | `Claude (AI-assisted)`          |
| **Reviewers** | `Accepted 2026-04-17`           |

## Context

The product ships a cross-platform desktop application alongside a CLI as part of V1 (ADR-014 lists Desktop GUI as feature 12). The desktop app renders a React + Vite UI, starts and watches the local daemon, handles native dialogs, implements auto-update, and hosts the preload bridge that sits between the renderer and the trusted main process (per `container-architecture.md`). The same React front end also runs as the web client that a phone or a browser uses to drive a session, so the desktop's front end is not a desktop-only choice. The desktop app runs no WebAuthn ceremony: passkeys, the owner's way to link a new device, live in the web client, the phone apps and the device-code page ([Spec-027](../specs/027-remote-control.md)).

Electron, Tauri 2.x (with and without Chromium embedded for the Preview pane), Wails v3 and GPUI are the frameworks this decision weighs. This ADR names the V1 desktop framework so [Plan-020](../plans/020-desktop-app-and-renderer.md) builds against a decided target.

## Problem Statement

What desktop framework should host the React + Vite renderer, start and watch the local daemon, and host the preload bridge across Windows, macOS, and Linux, given that the same front end also runs as the web client?

### Trigger

The console surface fixes a renderer budget, a terminal tier, and a Preview pane that embeds a browser, and the web client reuses the console's front end. Plan-020's scaffolding builds on the framework, so the framework is chosen first.

## Decision

Electron is the V1 desktop framework, and **V1 builds run on Electron 44.x only**.

Electron supports its latest three stable branches. V1 admits 44 alone because the console's `browser` pane kind depends on the detached-`WebContentsView` bounds fix ([electron/electron PR #53031](https://github.com/electron/electron/pull/53031)), which landed on 44 and reached 42 and 43 only as late backports — a 42.x or 43.x point release can clear every security floor and still lack the fix, and no per-branch fix floor can be verified from the release feed. Any build tooling or supervisor that selects a release on an end-of-life branch, or on 42 or 43 for a V1 build, is non-conformant.

Every release on a supported branch post-dates the fixed versions published in [GHSA-3c8v-cfp5-9885](https://github.com/electron/electron/security/advisories/GHSA-3c8v-cfp5-9885) for [CVE-2026-34776](https://nvd.nist.gov/vuln/detail/CVE-2026-34776) — an out-of-bounds heap read in the `requestSingleInstanceLock` second-instance IPC message parser on macOS and Linux, with Windows unaffected — so that floor is satisfied by construction and needs no separate check.

The Electron main process starts the local daemon as a detached process, never as its own child, and reaches it through the daemon's local socket or named pipe; it handles native dialogs and auto-update via `electron-updater`, and hosts the preload bridge. A quit leaves the daemon, every run and every terminal running. The renderer runs React + Vite under Chromium on macOS, Linux and Windows, and the same front end runs as the web client.

### Thesis — Why This Option

1. **One Chromium renderer on all three OSes.** Tauri and Wails use the OS-native webview — WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux — which triples the rendering-behavior QA matrix and, more concretely, triples the console's numbers. [Spec-021 §Console Design (Meridian)](../specs/021-desktop-app-and-renderer.md#console-design-meridian) §Budgets are single-number targets — ≤ 450 kB gzip initial bundle, p95 ≤ 16.7 ms frame time with four lanes streaming, ≤ 120 MB renderer heap at rest, ≤ 20 MiB per terminal instance — measured against the built bundle running in the desktop app, and the `@xterm/xterm` WebGL terminal tier is specified against Chromium's sixteen-context ceiling and its `onContextLoss` behavior ([Spec-021 §Console Libraries](../specs/021-desktop-app-and-renderer.md#console-libraries)). A native-webview framework needs three numbers per budget and three terminal tiers, which is a different product.
2. **The `browser` pane kind.** It is a main-process `WebContentsView` hosted beside the renderer with a `devtools-protocol`-typed `webContents.debugger` channel, which the daemon's relay joins into one browser for the agent's tools without opening a debug port ([Spec-021 §Console Libraries](../specs/021-desktop-app-and-renderer.md#console-libraries); [Spec-021 §Console Design (Meridian)](../specs/021-desktop-app-and-renderer.md#console-design-meridian); [ADR-034](./034-embedded-browser-for-preview.md)). WKWebView, WebView2, and WebKitGTK expose neither one embedding API nor one debugging protocol across macOS, Windows and Linux.
3. **A Node main process on the daemon's own contracts.** Main spawns the daemon detached, never as its own child, so a quit leaves the daemon, every run and every terminal running, and main reaches it through the daemon's local socket or named pipe ([Spec-021 §Detached Service Launch](../specs/021-desktop-app-and-renderer.md#detached-service-launch)). The daemon is the Node host for the `better-sqlite3` binding pinned to its Node-API line and the supervisor of the Rust PTY sidecar, and main imports the same `@ai-sidekicks/contracts` schemas the daemon and the client SDK are built on. A Rust or Go main process would restate those contracts in a second language.
4. **Mature cross-platform delivery ecosystem.** The app updates through `electron-updater` 6.8.10 as shipped: its stock GitHub provider, its SHA-512 check of the download, and the operating system's code signature on macOS and Windows. It ships as a dmg and a zip on macOS, an NSIS installer for x64 and arm64 on Windows, and an AppImage plus deb and rpm packages through a signed Cloudsmith repository on Linux, with delta downloads for the NSIS, macOS zip and AppImage channels; there is no Snap or Flatpak. Windows builds are signed through SignPath Foundation's free open-source program once it accepts the project, and publish unsigned until then; macOS builds carry the project's own self-signed code-signing identity, with the same bundle identifier on every build, until the Apple Developer certificate exists; both wait on [BL-108](../backlog.md#bl-108-windows--macos-signing-procurement-evidence). VS Code, Slack, Discord, Teams, Notion Desktop, 1Password (pre-8), and Figma Desktop all ship on Electron with large production footprints.
5. **Ecosystem alignment with the product's TypeScript-native stack.** The main process is Node.js; all first-party code (daemon, CLI, control plane) is TypeScript; no language-in-critical-path cost is added. The preload-bridge trust model (`container-architecture.md` §Trust Boundaries; renderer untrusted, main process trusted, daemon trusted) maps cleanly onto Electron's `contextBridge` API.

### Antithesis — The Strongest Case Against

Modern desktop users expect lightweight apps, and Electron's ~100 MB baseline bundle and heavy memory footprint (often 200–400 MB resident with a single window open) are the opposite of that. Tauri 2.x ships ~3 MB base bundles with an order-of-magnitude smaller memory footprint because it uses the OS-native webview rather than bundling Chromium. For a greenfield project making a decade-scale foundation commitment, starting with the modern lightweight option rather than the older heavy option is the default-correct choice. Rust brings memory safety, strong performance guarantees, and a clean tooling chain (cargo). Several high-profile projects have shipped on Tauri (1Password 8) or are evaluating migration from Electron. The cost-benefit looks like a clear Tauri win absent a specific blocker.

### Synthesis — Why It Still Holds

The antithesis wins on bundle size and loses on the renderer and, once the product's own panes are open, on memory. What decides is §Thesis: one Chromium renderer carrying single-number console budgets and one terminal tier, an in-process `WebContentsView` with a debugger channel for the `browser` pane on macOS, Linux and Windows, and a Node main process on the daemon's own contracts. Items 1 and 2 are each independently sufficient against a native-webview framework.

The memory claim does not hold for this product. Measured like for like on the session screen, on an Apple-silicon MacBook Pro with 16 GB running macOS 27, Electron with the Preview pane open used 418.6 MB across the app's own processes and Tauri with Chromium embedded for Preview used 380.5 MB, about 9% (38 to 46 MB across two runs) less. Opening Preview costs Electron 20 to 29 MB, one extra page process sharing the graphics and network processes it already has; it costs Tauri about 154 MB, because the embedded Chromium brings five processes of its own. At idle, Electron with Preview used 7.1% of one core against 13.5% for Tauri with Chromium. The processes that dominate the machine's memory are the providers' own, and the daemon stops an idle Claude Code session's process after 30 idle minutes, which is where memory is recovered.

Bundle size is addressed by asar packaging and by the fact that the target user already has VS Code or JetBrains installed (comparable footprint). Memory footprint is within the daemon-plus-app budget named in `deployment-topology.md`. The QA-matrix concern the antithesis understates is exactly what has driven production teams to migrate _to_ Electron from native-webview frameworks; behavioral drift across WKWebView / WebView2 / WebKitGTK scales test costs with platform count. Electron's uniform Chromium scales test costs with feature count only.

## Alternatives Considered

### Option A: Electron (Chosen)

- **What:** Chromium renderer with a Node.js main process, `contextBridge` preload, `electron-updater` 6.8.10 with its stock GitHub provider for auto-update with delta downloads, `electron-builder` for packaging into dmg and zip, NSIS x64 and arm64, AppImage, deb and rpm; Windows signing through SignPath Foundation.
- **Steel man:** Uniform Chromium renderer on macOS, Linux and Windows — one set of console budget numbers, one terminal tier, and one `WebContentsView` + debugger path for the Preview pane's embedded browser; a Node main process that spawns the daemon detached and shares its contracts; mature ecosystem (VS Code, Slack, Discord, Teams, Notion, Figma Desktop); TypeScript-native main process aligns with the rest of the stack; preload-bridge model maps to the renderer-untrusted trust boundary.
- **Weaknesses:** 100 MB+ baseline bundle; 418.6 MB across the app's own processes on the session screen with Preview open, about 38 to 46 MB more than Tauri with Chromium for Preview; Chromium security-patch cadence tied to Electron release cadence; Node.js in the main process expands the attack surface vs a Rust or Go host.

### Option B: Tauri 2.x, with or without Chromium for Preview (Rejected)

- **What:** Rust main process, OS-native webview on each platform (WKWebView macOS, WebView2 Windows, WebKitGTK Linux), TypeScript/React renderer. The variant weighed here also embeds Chromium through the Chromium Embedded Framework for the Preview pane only, so the agent's page runs in real Chromium while the console runs in the system webview.
- **Steel man:** ~3 MB base bundle; lower baseline memory; memory-safe Rust host; clean `cargo` tooling chain; 1Password 8 production precedent; Tauri v2 stable. The Chromium variant was built and works: a Tauri 2.11 app on macOS hosted a Chromium page inside one pane of the same window, Playwright attached to it and drove it, a person's clicks and keys reached the same page, and the app's own processes used 380.5 MB with Preview open against Electron's 418.6 MB.
- **Why rejected:**
  1. The console constraints in §Thesis — single-number budgets, one terminal tier, and the `WebContentsView` + debugger requirement of the `browser` pane — are met by WKWebView / WebView2 / WebKitGTK with neither one API nor one protocol.
  2. Triple-webview behavior drift (WKWebView vs WebView2 vs WebKitGTK) turns every renderer-behavior test into three tests. This is a documented migration driver for production teams moving from native-webview frameworks to Chromium-based ones. On the console's own screens in WebKit, the differences left after one missing character-set line was fixed included macOS focus rules (Tab skips buttons and links, a clicked button does not take focus), an unprefixed `user-select` WebKit ignores, a `ResizeObserver` loop error only WebKit raises, text sitting 1 to 5 px lower, and voice playback reaching its stream 0.5 to 0.8 s after `play()` against about 0.03 s in Chromium.
  3. Embedding Chromium for Preview puts four desktop engines in one product — three system webviews plus Chromium — and custom glue the project maintains in Rust, on macOS alone including a shim that adds Chromium's required application protocols to Tauri's own application class and an external message pump for Chromium under Tauri's event loop. It also reached the page over a remote-debugging port, which the product does not open ([ADR-034](./034-embedded-browser-for-preview.md)).
  4. The memory saving is small and moves the wrong way as panes open: about 9% (38 to 46 MB) with Preview open, while opening Preview costs Tauri about 154 MB against Electron's 20 to 29 MB, and Tauri with Chromium used 13.5% of one core at idle against Electron's 7.1%. The providers' own processes dominate the machine's memory, and the daemon's idle stop of a Claude Code session addresses them.
  5. Rust in the main process adds a language-in-critical-path cost to a TypeScript-native team, and restates the daemon's contracts in a second language.

### Option C: Wails v3 (Rejected)

- **What:** Go main process, OS-native webview (same engines as Tauri on each platform), Go→JS bindings.
- **Steel man:** Similar bundle-size and memory benefits to Tauri; Go ergonomics for backend-familiar developers; simpler build chain than Rust.
- **Why rejected:**
  1. Same native-webview position as Tauri: the console constraints in §Thesis apply identically (Option B point 1), and the WebKit differences measured on the console's own screens (Option B point 2) are Wails' differences on macOS too.
  2. The Wails v3 status page lists v3 as alpha, with no flagship production apps on it. A desktop framework is a decade-scale foundation commitment; building on alpha tooling is insufficient risk management.
  3. Team is TypeScript-native, not Go-native; introduces language-in-critical-path cost without the offsetting team-expertise benefit that would justify it.

### Option D: Native per-platform apps (Rejected)

- **What:** SwiftUI on macOS, WinUI on Windows, GTK or Qt on Linux.
- **Steel man:** Best native UX on each platform; true zero-overhead baseline footprint; full access to per-platform capabilities.
- **Why rejected:** Triples implementation effort; no shared UI code across platforms or with the web client; breaks the shared-SDK-between-CLI-and-desktop pattern the vision establishes; V1 timeline cannot absorb three parallel native app implementations.

### Option E: GPUI (Rejected)

- **What:** Zed's Rust UI framework, drawing every window itself on the GPU, with a web client compiled to WebAssembly through its web backend and drawn into one canvas.
- **Steel man:** One Rust front end across the desktop and the web; no web engine in the desktop app at all; a GPU-drawn interface built for an editor's frame rates; a public-beta GPUI web client already exists.
- **Why rejected:**
  1. The product keeps one front end across the desktop app, the web client and the phone. GPUI either breaks that — a GPUI desktop beside a React web client — or ships the web client as WebAssembly, and no GPUI WebAssembly build found comes near the web client's 450 kB first-download budget: the GPUI component gallery is 9.9 MB gzip, 22 times the budget, and a shipped GPUI web client downloads 22.0 MB with brotli.
  2. A canvas-drawn web client exposes nothing to screen readers, on the browser and on the phone that reaches sessions through it.
  3. The `browser` pane and the Chromium-specific terminal tier still need Chromium, which GPUI does not carry.
  4. Rust in the main process adds a language-in-critical-path cost to a TypeScript-native team.

## Assumptions Audit

| # | Assumption | Evidence | What Breaks If Wrong |
| --- | --- | --- | --- |
| 1 | Electron tracks Chromium security patches within 1–2 weeks of Chromium stable releases. | Electron has consistently met this cadence in 2025–2026 release history; Electron maintains a documented patch SLA across its supported stable branches. | We would need to monitor Chromium CVE feeds ourselves, or move to Chromium-Embedded-Framework directly, or change frameworks. |
| 2 | Electron's branch 44 continues to publish point releases, and the supported set stays 42 / 43 / 44 until 42 ages out. | [releases.electronjs.org](https://releases.electronjs.org/) publishes the 44.x point releases; branch 41 reached end of support with the 44.0.0 release, and the published end-of-life dates are 2026-10-20 for 42, 2027-01-05 for 43, and 2027-03-02 for 44. Electron supports the latest three stable branches per the [electron/electron release timeline](https://www.electronjs.org/docs/latest/tutorial/electron-timelines). | Branch 44 ages out before V1 ships, and the V1 target moves to the next branch carrying the `WebContentsView` bounds fix; the build supervisor fails closed rather than selecting an end-of-life branch. |
| 3 | `electron-updater` delta-patch flow is reliable across Windows, macOS, Linux. | Proven at scale by VS Code, 1Password (pre-8), Slack, and others. | Larger update payloads; ongoing bandwidth cost; user-visible update-time regression. |
| 4 | The ~100 MB baseline bundle is acceptable to our target developer audience. | VS Code (~100 MB) and JetBrains IDEs (500 MB+) receive no material user pushback on install size. Our target user already has similar-footprint tools installed. | Competitive pressure from a lightweight alternative with feature parity; revisit trigger 4 fires. |
| 5 | The app's own processes stay a small share of the machine's memory next to the providers' processes. | The session screen with Preview open used 418.6 MB across the app's own processes; the best alternative measured, Tauri with Chromium for Preview, saved 38 to 46 MB. | Revisit trigger 4 fires, and the saving an alternative offers is measured again on the same screens before any change. |

Plan-020's CI checks assumptions 2 and 3; release monitoring watches 1, 4 and 5.

## Failure Mode Analysis

| Scenario | Likelihood | Impact | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Electron security-patch cadence slips; Chromium CVE unpatched for weeks | Low | High | Automated release-tracking; Chromium CVE feed monitoring | Manual Chromium-patch integration on a maintenance branch; evaluate alternative frameworks |
| Chromium memory-footprint regression under load | Med | Med | Runtime memory metrics via observability; daemon memory-budget alerts | Renderer-process isolation; lazy-load non-critical panels |
| Team gains Rust-comfortable engineer with bandwidth (reversal trigger) | Low | Low (positive signal) | Team-composition change | Not a forcing failure; evaluate Tauri revisit window per revisit trigger 2 |
| Electron removes or breaks the `contextBridge` preload model | Low | High | Electron release notes; contract conformance tests | Pin to previous Electron major; migrate to an alternative framework |
| electron-updater signing pipeline breaks on code-signing-cert rotation | Low | Med | CI signing tests; cert-expiry monitoring | Standby cert; documented rotation runbook |

## Reversibility Assessment

- **Reversal cost:** Very high once V1 desktop ships. A framework migration touches every renderer-to-main IPC surface, packaging pipeline, auto-update mechanism, code-signing certificate chain, install-tool UX, and native-dialog integration. Multi-month migration under realistic assumptions. Shipped desktop code already binds the Electron main API directly — `app`, `BrowserWindow` and the `App` type in the main process, `contextBridge` in the preload — and the renderer's own protocol is served through `protocol.registerSchemesAsPrivileged` and `net.fetch`, for which the native-webview frameworks offer no equivalent.
- **Blast radius:** the desktop app's main process and renderer, preload bridge contracts, auto-update infrastructure, signed-release pipeline, user-install tooling, every user with an installed version of the prior desktop app.
- **Migration path:** Build a parallel desktop target under a new package; migrate renderer code (React + Vite is framework-agnostic); migrate the preload bridge to the new framework's equivalent; migrate auto-update; cut over in a major version.
- **Point of no return:** First V1 desktop release ships to users. Before that milestone, reversal is implementation-cost only, not user-migration cost.

## Consequences

### Positive

- The console's budgets, terminal tier, and `browser` pane are each specified once, against one engine, rather than three times.
- Renderer QA matrix scales with feature count, not with platform count.
- Mature `electron-updater` auto-update pipeline reduces custom infrastructure work.
- TypeScript-native main process aligns with daemon, CLI, and control-plane language choice; no cross-language critical-path cost.

### Negative (accepted trade-offs)

- ~100 MB baseline bundle; accepted because target developer users already have comparable-or-larger IDE installs.
- Higher resident memory than a native-webview framework: about 38 to 46 MB more than Tauri with Chromium for Preview on the session screen with Preview open; within the capacity budget named in `deployment-topology.md`.
- Node.js in the main process expands attack surface vs a Rust/Go host; mitigated by the renderer-untrusted preload-bridge trust model from `container-architecture.md`.
- Desktop security-patch cadence is coupled to Electron's upstream cadence; Electron has a reliable track record but is a non-zero dependency risk.

### Unknowns

- Exact V1 desktop bundle size under asar + production optimizations — to be measured in Plan-020 CI once the app's packaging lands.

## Decision Validation

### Success Criteria

| Metric | Target | Measurement Method | Check Date |
| --- | --- | --- | --- |
| Desktop bundle size (post-asar, post-compression), without the Linux runtime archives a Windows installer carries | < 150 MB | CI artifact size check | When Plan-020's packaging lands |
| Windows installer size with no Linux runtime archive, with the glibc archive and with both | Measured; no cap of its own, because the archives ship so the first start works offline | Release build size check ([Plan-020](../plans/020-desktop-app-and-renderer.md) T-020r-6-5) | When Plan-020's packaging lands |
| Auto-update delta patches ship | Delta install < 30% of full bundle | `electron-updater` release test | When the first update ships |
| Renderer-to-main IPC conformance with ADR-009 | 100% of IPC uses Content-Length JSON-RPC | Contract test suite | When Plan-020's preload bridge lands |

### Revisit Triggers

1. A native-webview framework can meet the console constraints in §Thesis — one set of budget numbers, one terminal tier, and an in-process browser view with a debugger channel and no debug port on macOS, Linux and Windows — evaluate a Tauri re-assessment window if bundle-size pressure has materialized.
2. Team gains a Rust-comfortable engineer with bandwidth to own a migration — evaluate Tauri re-assessment window with team composition supporting the Rust learning curve.
3. Electron drops or materially changes the `contextBridge` preload model — evaluate alternative frameworks regardless of other factors.
4. Desktop bundle size or memory footprint becomes a primary user complaint at a measurable rate — measure the alternatives again on the same screens, like for like, before choosing between them and optimizing within Electron.

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| Electron releases | Documentation | Chromium security-patch SLA, preload bridge stability | <https://www.electronjs.org/releases> |
| Electron release timeline | Documentation | "Latest three stable branches" support policy | <https://www.electronjs.org/docs/latest/tutorial/electron-timelines> |
| Electron 44 release post + releases feed | Changelog + registry | 44.0.0 released 2026-08-25 (Chromium 152.0.7977.54 / Node 24.18.1) and Electron 41.x end-of-support declared in the same post; 44.1.1 published 2026-09-01; supported majors 44 / 43 / 42 | <https://www.electronjs.org/blog/electron-44-0> |
| GHSA-3c8v-cfp5-9885 | Security advisory (primary) | Fixed-version floors 38.8.6 / 39.8.1 / 40.8.1 / 41.0.0 for the `requestSingleInstanceLock()` second-instance IPC parser out-of-bounds heap read on macOS and Linux (Windows unaffected) | <https://github.com/electron/electron/security/advisories/GHSA-3c8v-cfp5-9885> |
| NVD CVE-2026-34776 | CVE record (primary) | CWE-125 out-of-bounds read; CVSS 3.1 base 5.3 (vector `AV:L/AC:H/PR:L/UI:N/S:U/C:H/I:N/A:L`) | <https://nvd.nist.gov/vuln/detail/CVE-2026-34776> |
| Tauri v2 documentation | Documentation | OS-native webview strategy; WebKitGTK on Linux | <https://v2.tauri.app/> |
| Wails v3 status page | Documentation | v3 alpha status; no flagship production apps | <https://wails.io/> |
| Chromium Embedded Framework | Documentation | Embedding Chromium in a native window: external message pump, `DoClose` life-cycle, the application protocols CEF requires of `NSApp` on macOS | <https://chromiumembedded.github.io/cef/general_usage> |
| GPUI | Documentation | Zed's GPU-drawn Rust UI framework and its web backend drawing into one canvas | <https://www.gpui.rs/> |
| electron-updater | Documentation | Auto-update with the GitHub provider and differential downloads | <https://www.electron.build/docs/features/auto-update> |
| SignPath Foundation | Documentation | Free code signing for open-source projects | <https://signpath.org/> |

### Related ADRs

- [ADR-010: Tokens, Passkeys And The Remote Channel](./010-tokens-passkeys-and-the-remote-channel.md) — the per-connection channel between the person's devices and machines, and passkeys kept to the web client, the phone apps and the device-code page, so the desktop app carries no WebAuthn.
- [ADR-034: Embedded Browser For Preview](./034-embedded-browser-for-preview.md) — the `browser` pane's debugger relay with no debug port, which Thesis item 2 relies on.
- [ADR-009: JSON-RPC IPC Wire Format](./009-json-rpc-ipc-wire-format.md) — the IPC wire format the preload bridge reuses between renderer and main.
- [ADR-014: V1 Feature Scope Definition](./014-v1-feature-scope-definition.md) — names Desktop GUI as a V1 feature; this ADR enables it.

### Related Docs

- [Container Architecture](../architecture/container-architecture.md) — renderer-untrusted / main-process-trusted / daemon-trusted trust model that this ADR implements.
- [Desktop Architecture](../architecture/desktop.md) — desktop-specific component decomposition.
- [Vision §Technology Position](../vision.md#technology-position) — Electron named as the desktop framework in the Keep section.
