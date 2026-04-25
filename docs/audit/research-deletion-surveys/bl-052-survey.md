# BL-052 Survey — External Citations for ADR-019 Embed (T9)

**Survey date:** 2026-04-25
**Subject brief:** `docs/research/bl-052-windows-tier-research.md` (Windows V1 tier evaluation; recommended Option C V1 Beta under human-implementation cost model; superseded by ADR-019 under AI-implementation cost model)
**Consuming ADR:** `docs/decisions/019-windows-v1-tier-and-pty-sidecar.md` (Windows V1 GA + Rust PTY sidecar)
**Existing ADR-019 `### Research Conducted` table:** lines 169–184 (12 rows already present — see "ALREADY PRESENT" markers below to avoid T12 duplication)
**Pattern reference:** `docs/decisions/016-electron-desktop-shell.md` lines 151–164; `docs/decisions/017-shared-event-sourcing-scope.md` lines 111–122
**Strategy:** surface-external-citations (NOT distribute-by-topic prose absorption)

This survey is the durable artifact for downstream task **T12 (embed bl-052 citations into ADR-019)**. T12 should require zero re-reading of bl-052 itself.

---

## §1 — Bibliography + Destination Map

The brief consolidates its citations in §9 (lines 261–308). All URLs below are taken from that source-of-truth list plus three in-text-only references not duplicated to §9 (`nodejs/node#62125` is in §9 but only as plain text, not URL; `microsoft/node-pty#490` and `microsoft/node-pty#715` are mentioned in body prose but absent from §9). Each row is annotated with whether the citation is **ALREADY PRESENT** in ADR-019's existing table (lines 169–184, no T12 action needed for the URL row — but verify the existing row's "Key Finding" prose against this survey if T12 wants to enrich it) or **NEW ROW** (T12 must insert as a new row).

Priority annotations (HIGH / MED / SUPPLEMENTAL) help T12 be selective. The brief's full set is ~37 citations; ADR-019's existing table is 12 rows; not every citation needs to land. HIGH = load-bearing for ADR-019's decision rationale, MED = supports an absorbed claim that would benefit from a primary-source row, SUPPLEMENTAL = informational/illustrative; a clean ADR-019 table can omit these.

| # | Source | Type | Key Finding (1-sentence) | URL | Destination |
|---|--------|------|-------------------------|-----|-------------|
| 1 | openai/codex#13973 | GitHub Issue | First-party Codex-driver ConPTY assertion (`remove_pty_baton`) firing both under config-error and during ordinary Codex desktop shutdown; OPEN as of 2026-03-08 | https://github.com/openai/codex/issues/13973 | **ALREADY PRESENT** in ADR-019 table line 174 — no T12 action; this is the load-bearing trigger citation. (Priority: HIGH-existing) |
| 2 | microsoft/node-pty#904 | GitHub Issue | `SIGABRT` on Electron exit via ThreadSafeFunction cleanup race; same class as codex#13973; OPEN 2026-03-27 | https://github.com/microsoft/node-pty/issues/904 | **ALREADY PRESENT** in ADR-019 table line 175 — no T12 action. (Priority: HIGH-existing) |
| 3 | microsoft/node-pty#887 | GitHub Issue | ConoutConnection worker thread prevents Node.js from exiting after `kill()`; OPEN 2026-04-06 | https://github.com/microsoft/node-pty/issues/887 | **ALREADY PRESENT** in ADR-019 table line 176 — no T12 action. (Priority: HIGH-existing) |
| 4 | microsoft/node-pty#894 | GitHub Issue | Severe ~3.5 s output delay with `useConptyDll: true` + PowerShell 7; blocks the bundled-ConPTY workaround; OPEN 2026-03-11 | https://github.com/microsoft/node-pty/issues/894 | **ALREADY PRESENT** in ADR-019 table line 177 — no T12 action. (Priority: HIGH-existing) |
| 5 | microsoft/node-pty#437 | GitHub Issue | `ptyProcess.kill()` hangs / process tree kill not reliable on Windows | https://github.com/microsoft/node-pty/issues/437 | **ALREADY PRESENT** in ADR-019 table line 178 — no T12 action. (Priority: HIGH-existing) |
| 6 | microsoft/node-pty#647 | GitHub Issue | Spawn locks the cwd on Windows (blocks worktree workflows) | https://github.com/microsoft/node-pty/issues/647 | **ALREADY PRESENT** in ADR-019 table line 179 — no T12 action. (Priority: HIGH-existing) |
| 7 | Eugeny/tabby#10134 | GitHub Issue (precedent) | Tabby GA on `node-pty` hit the same ConPTY assertion → user-rollback wave; closed by pinning node-pty | https://github.com/Eugeny/tabby/issues/10134 | **ALREADY PRESENT** in ADR-019 table line 180 — no T12 action; this is the load-bearing precedent citation. (Priority: HIGH-existing) |
| 8 | wezterm/portable-pty source tree | Reference implementation | Production Rust PTY crate used by wezterm; cross-platform ConPTY on Windows | https://github.com/wezterm/wezterm/tree/main/pty | **ALREADY PRESENT** in ADR-019 table line 181 — no T12 action. (Priority: HIGH-existing) |
| 9 | Tauri v2 sidecar docs | Documentation | Sidecar spawn + lifecycle patterns (pattern-informative, Tauri-specific) | https://v2.tauri.app/develop/sidecar/ | **ALREADY PRESENT** in ADR-019 table line 182 — no T12 action. (Priority: HIGH-existing) |
| 10 | `@esbuild/*` npm packages | Distribution precedent | Platform-specific binary distribution via `optionalDependencies` + `os`/`cpu` filters | https://www.npmjs.com/package/esbuild | **ALREADY PRESENT** in ADR-019 table line 183 — no T12 action. (Priority: HIGH-existing) |
| 11 | Azure Artifact Signing FAQ | Documentation | Eligibility (USA / Canada / EU / UK orgs; USA / Canada individual devs) and signing pipeline integration | https://learn.microsoft.com/en-us/azure/artifact-signing/faq | **ALREADY PRESENT** in ADR-019 table line 184 — no T12 action. (Priority: HIGH-existing) |
| 12 | microsoft/node-pty#827 | GitHub Issue | Windows crash on Node.js v22 — "Cannot resize a pty that has already exited"; thrown error (uncaught → process exit); Gemini CLI users hit in production; OPEN 2026-03-13 | https://github.com/microsoft/node-pty/issues/827 | **NEW ROW** — extend ADR-019 §Research Conducted table after line 179 (group with the rest of the node-pty issue cluster). Justifies "bug cluster" framing in ADR-019 §Context lines 16–24, which currently lists 6 issues (`#904`, `#887`, `#894`, `#437`, `#647`, `#13973`) but omits `#827`. (Priority: HIGH — directly extends the "bug cluster" inventory the ADR rests on) |
| 13 | microsoft/node-pty#167 | GitHub Issue | Sending a signal to all processes in the processgroup of the pts; Ctrl+C / SIGINT propagation does not reach process group on Windows | https://github.com/microsoft/node-pty/issues/167 | **NEW ROW** — extend ADR-019 table. Supports the brief's §6 gotcha "Ctrl+C propagation" which is NOT YET captured in ADR-019 (see §3 below). T12 should add this row AND consider a one-paragraph addition to ADR-019 §Failure Mode Analysis or §Consequences naming Ctrl+C propagation as a daemon-layer responsibility. (Priority: MED) |
| 14 | microsoft/node-pty#842 | GitHub Issue | Removed winpty support; ConPTY (Windows 10 1809+) is now the only supported backend (telemetry: <0.1% pre-ConPTY) | https://github.com/microsoft/node-pty/issues/842 | **NEW ROW** — extend ADR-019 table. Supports ADR-019's implicit assumption that ConPTY (not winpty) is the only relevant Windows backend. Rationale-strengthening, not load-bearing. (Priority: MED) |
| 15 | microsoft/node-pty releases | Documentation | `v1.2.0-beta.12` (2026-03-12) is current; no stable 1.2.0 has shipped; bundled conpty `1.25.260303002`; `useConptyDll` option added | https://github.com/microsoft/node-pty/releases | **NEW ROW** — extend ADR-019 table. ADR-019 Tripwire 3 (line 165) explicitly references "node-pty v1.2.0 stable" without a primary-source link to the release stream — this row provides that anchor. (Priority: HIGH — Tripwire 3 currently lacks a citation) |
| 16 | microsoft/vscode#224488 | GitHub Issue | "Ship newer version of conpty" — VS Code's stalled ask; "fixes in ConPTY can take 1–2 years to make it to users" | https://github.com/microsoft/vscode/issues/224488 | **NEW ROW** — extend ADR-019 table. Supports the "industry norm absorbs ConPTY bugs" framing in ADR-019 lines 62, 78. (Priority: MED) |
| 17 | microsoft/vscode#242891 | GitHub Issue | "Killing tasks does not actually kill them" (Windows) — VS Code task-kill leak, regression | https://github.com/microsoft/vscode/issues/242891 | **NEW ROW** — extend ADR-019 table. Co-supports `node-pty#437` (process-tree-kill unreliability). (Priority: SUPPLEMENTAL — overlaps with #437 already in table; T12 may skip) |
| 18 | microsoft/vscode#245709 | GitHub Issue | ConPTY assertion failure on new window (in VS Code) — same assertion class as the trigger | https://github.com/microsoft/vscode/issues/245709 | **NEW ROW** — extend ADR-019 table. Strengthens "this assertion class affects production VS Code" claim. (Priority: MED) |
| 19 | microsoft/vscode#308519 | GitHub Issue | Integrated terminal duplicates output after switching VS Code windows on Windows | https://github.com/microsoft/vscode/issues/308519 | **NEW ROW** — extend ADR-019 table. (Priority: SUPPLEMENTAL — illustrative of "long tail of open Windows terminal bugs"; T12 may skip) |
| 20 | microsoft/vscode#255285 | GitHub Issue | Terminal viewport shifts left with Chinese IME in `gemini cli` on Windows ConPTY (Unicode/IME edge case) | https://github.com/microsoft/vscode/issues/255285 | **NEW ROW** — extend ADR-019 table. (Priority: SUPPLEMENTAL — supports brief §6 Unicode/IME gotcha which is not in ADR-019; T12 may skip unless adding a §Failure-Mode row for IME) |
| 21 | microsoft/vscode#252489 | GitHub Issue | "Terminal commands are not reliable when conpty dll is false" — corroborates `useConptyDll: true` is the forward direction | https://github.com/microsoft/vscode/issues/252489 | **NEW ROW** — extend ADR-019 table. Supports ADR-019 Option D (Deferred). (Priority: MED) |
| 22 | microsoft/vscode#239184 | GitHub Issue | SentinelOne EDR detected Electron as a security threat (closed but live pattern) | https://github.com/microsoft/vscode/issues/239184 | **NEW ROW** — extend ADR-019 table. Supports brief §5 AV/EDR analysis which is NOT YET captured in ADR-019 (see §3 below). (Priority: MED — only if T12 also adds AV/EDR risk to ADR-019 body; otherwise SUPPLEMENTAL) |
| 23 | microsoft/vscode#201029 | GitHub Issue | Remote-SSH `AttachConsole failed, could not find pty on pty host` — class of Windows-specific PTY host errors | https://github.com/microsoft/vscode/issues/201029 | **NEW ROW** — extend ADR-019 table. (Priority: SUPPLEMENTAL — illustrative of long-tail Windows PTY issues; T12 may skip) |
| 24 | microsoft/terminal discussion #19112 | GitHub Discussion | "ConPTY Version probing" — context for whether bundled-ConPTY-DLL strategy works | https://github.com/microsoft/terminal/discussions/19112 | **NEW ROW** — extend ADR-019 table. Supports ADR-019 Option D (Deferred) discussion. (Priority: SUPPLEMENTAL) |
| 25 | Zed — "Windows When? Windows Now" blog | Engineering blog | Zed shipped Windows GA 2025-10-15 day-one with terminal working; uses `alacritty_terminal` (Rust PTY, not node-pty) | https://zed.dev/blog/zed-for-windows-is-here | **NEW ROW** — extend ADR-019 table. Provides primary-source precedent for "Rust PTY is reliable on Windows," which strengthens ADR-019 §Synthesis but is currently absent from the citations. (Priority: HIGH — closest precedent for the chosen architecture; ADR-019 should cite this) |
| 26 | Zed terminal core docs (DeepWiki mirror) | Documentation (third-party mirror) | Zed terminal architecture: Rust-native PTY via `alacritty_terminal` | https://deepwiki.com/zed-industries/zed/9.1-terminal-core | **NEW ROW** — extend ADR-019 table, but **flag DeepWiki is a third-party mirror** — primary source would be the upstream zed-industries/zed repo. T12 should consider whether to cite DeepWiki or chase the upstream-repo source path; if DeepWiki, mark "(third-party mirror)" in the Type column. (Priority: MED — corroborates row 25 with implementation detail) |
| 27 | Warp terminal — "Warp Terminal is now on Windows" | Vendor announcement (Rust-Lang forum thread) | Rust-native terminal explicitly labeled Windows BETA — "Warp chose C (not A or B) despite being Rust-native"; counterexample to the chosen path | https://users.rust-lang.org/t/warp-terminal-is-now-on-windows/126290 | **NEW ROW** — extend ADR-019 table. Notable counterexample worth citing in §Antithesis (Warp is Rust-native and STILL chose Beta on Windows). (Priority: HIGH — only counterexample for the chosen architecture; absent from ADR-019) |
| 28 | wavetermdev/waveterm | GitHub repo | Wave Terminal: Electron + Go (`aymanbagabas/go-pty`) sidecar pattern; closest real-world analog to the chosen sidecar pattern (but Go, not Rust) | https://github.com/wavetermdev/waveterm | **NEW ROW** — extend ADR-019 table. Supports the brief's §3.1 "no headline Electron devtool ships a Rust sidecar specifically for PTY" finding — Wave is the closest precedent (Go sidecar, not Rust). ADR-019 §Decision references the sidecar pattern but does not cite this precedent. (Priority: HIGH — load-bearing precedent for the IPC architecture choice) |
| 29 | anthropics/claude-code | GitHub repo | Claude Code: Node CLI ships Windows GA on Git Bash + node-pty (precedent for "first-party agentic CLI shipping Windows GA on JS PTY stack") | https://github.com/anthropics/claude-code | **NEW ROW** — extend ADR-019 table. Supports the "industry norm" set in ADR-019 lines 14, 62, 78 (claude-code is named there but not cited). (Priority: MED) |
| 30 | portable-pty on crates.io | Documentation (crate listing) | Latest crates.io version `0.9.0`; lives in wezterm monorepo; mature, used outside wezterm | https://crates.io/crates/portable-pty | **NEW ROW** — extend ADR-019 table. Complements row 8 (wezterm/pty source tree); T12 should consider whether to cite both the source tree (existing line 181) and the crates.io listing, or merge. (Priority: MED) |
| 31 | aymanbagabas/go-pty | GitHub repo | Cross-platform Go PTY library; ConPTY on Windows; used in Wave Terminal | https://github.com/aymanbagabas/go-pty | **NEW ROW** — extend ADR-019 table. (Priority: SUPPLEMENTAL — only relevant if T12 also cites Wave per row 28) |
| 32 | creack/pty | GitHub repo | Historically Unix-only Go PTY; Windows ConPTY in PR churn for years (#95, #109, #155, #169) | https://github.com/creack/pty | **NEW ROW** — extend ADR-019 table. Supports brief §2.4 alternatives analysis. (Priority: SUPPLEMENTAL — alternatives that were rejected don't need their own ADR row; T12 may skip) |
| 33 | andfoy/winpty-rs | GitHub repo | Legacy Rust crate; rarely relevant now that winpty support is dead upstream | https://github.com/andfoy/winpty-rs | **NEW ROW** — extend ADR-019 table. (Priority: SUPPLEMENTAL — rejected alternative; T12 may skip) |
| 34 | homebridge/node-pty-prebuilt-multiarch | GitHub repo | Parallel node-pty fork with prebuilt binaries (ia32/amd64/arm/aarch64); cited in Codex/Gemini CLI stack traces | https://github.com/homebridge/node-pty-prebuilt-multiarch | **NEW ROW** — extend ADR-019 table. Supports brief §2.3 fork-ecosystem signal that is currently absent from ADR-019. (Priority: MED) |
| 35 | GitHub Actions runner pricing | Documentation | Per-minute cost: Linux $0.006, Windows $0.010 (post-2026-01-01 reduction; effective ~1.67× multiplier) | https://docs.github.com/en/billing/reference/actions-runner-pricing | **NEW ROW** — extend ADR-019 table. Supports brief §4 CI matrix cost analysis. ADR-019 §Reversibility line 116 references "CI cross-compile matrix" but does not cite pricing. (Priority: MED — CI cost is one of the "negative trade-offs" ADR-019 accepts in lines 134, 136) |
| 36 | GitHub 2026 Actions pricing changes | Vendor announcement | The 2026-01-01 ~39% Actions price cut + flat $0.002/min cloud-platform charge | https://github.com/resources/insights/2026-pricing-changes-for-github-actions | **NEW ROW** — extend ADR-019 table. Co-supports row 35. (Priority: SUPPLEMENTAL — overlaps with row 35; T12 may consolidate) |
| 37 | Electron code-signing tutorial | Documentation | Canonical Electron code-signing reference (precedes Azure Artifact Signing path) | https://www.electronjs.org/docs/latest/tutorial/code-signing | **NEW ROW** — extend ADR-019 table. Complements row 11 (Azure Artifact Signing FAQ); the brief's §3.2 cites both. (Priority: MED) |
| 38 | Security Boulevard 2025-12 — "How to sign a Windows app with electron-builder" | Engineering blog | Azure Trusted Signing as cheapest credible path for Electron-builder; SmartScreen reputation context | https://securityboulevard.com/2025/12/how-to-sign-a-windows-app-with-electron-builder/ | **NEW ROW** — extend ADR-019 table. Supports the SmartScreen-pooling claim in ADR-019 line 52. (Priority: MED) |
| 39 | nodejs/node#62125 | GitHub Issue | Windows detached-spawn silent termination on Node 24.13; cross-referenced from `node-pty#887` | https://github.com/nodejs/node/issues/62125 | **NEW ROW** — extend ADR-019 table. **NOTE: brief §9 line 308 lists this citation as plain text without a URL** (only the issue number `#62125`). The URL above is reconstructed from the standard nodejs/node issue URL pattern; T12 should verify the link resolves before embedding. Supports the "Node.js Windows regressions cross-pollinate" claim in brief §5; not currently in ADR-019. (Priority: MED) |
| 40 | microsoft/node-pty#490 | GitHub Issue (in-text only) | VS Code's upstream improvement push; cross-referenced from brief §3.1 line 99 — NOT in §9 source list | (URL not provided in brief; reconstruct: https://github.com/microsoft/node-pty/issues/490) | **NEW ROW** — extend ADR-019 table. **ANOMALY: brief mentions this in body prose (line 99) but omits it from §9 source consolidation.** T12 should verify the URL and the issue's actual content before citing. (Priority: SUPPLEMENTAL — minor reference) |
| 41 | microsoft/node-pty#715 | GitHub Issue (in-text only) | Non-Windows SIGINT flake; brief §4 line 137 cites it as illustrative of the "PTY test flake" category; NOT in §9 source list | (URL not provided in brief; reconstruct: https://github.com/microsoft/node-pty/issues/715) | **NEW ROW** — extend ADR-019 table. **ANOMALY: brief mentions in body prose only.** (Priority: SUPPLEMENTAL — illustrative) |

### §1 footer — Backlog line 250 disposition

`docs/backlog.md` line 250–252 (BL-052 entry — see survey input section preceding §1) **already contains all the load-bearing external URLs inline** in the References field. Specifically: `openai/codex#13973`, `node-pty#904/#887/#894/#437/#647`, `Eugeny/tabby#10134`, `wezterm/pty (portable-pty)`, `Tauri v2 sidecar docs`, `@esbuild/*` are all directly cited in line 251.

**Recommendation for T12 with respect to backlog:** **No edits needed to backlog.md line 250 area.** The backlog entry already meets the citation-flow standard; cross-ref to ADR-019 (already implicit since BL-052's exit criteria require ADR-019 to exist at `docs/decisions/019-windows-v1-tier-and-pty-sidecar.md`) is sufficient. T12 should NOT add new citations to backlog — keep them in ADR-019's `### Research Conducted` table per the corpus convention.

---

## §2 — Absorption Confirmed

For each major analytic claim in the brief, this section confirms the claim is already present in ADR-019 body prose. (These are claims that do NOT need re-embedding via T12 because they're already absorbed.)

1. **Brief's claim that node-pty has a known open Windows ConPTY bug cluster centered on `remove_pty_baton` / ThreadSafeFunction race** → captured in ADR-019 §Context lines 16–24 (six bullet citations) and §Decision lines 56–58 (Thesis). Load-bearing for the Decision.

2. **Brief's claim that Tabby#10134 is the direct precedent for "ship GA on this bug class → user rollback wave"** → captured in ADR-019 §Context lines 25 ("Tabby's closure strategy was to pin to an older `node-pty` version — a workaround, not a structural fix"), §Decision Thesis line 56 ("puts us on the same path Tabby walked"), and §Antithesis line 62 ("the Tabby rollback wave was specifically about one class of the ConPTY assertion").

3. **Brief's claim that `portable-pty` (wezterm) is the production Rust alternative that doesn't share node-pty's bug cluster** → captured in ADR-019 §Context line 27 ("`portable-pty` is the production PTY crate used by wezterm…ships without the `node-pty` bug cluster") and §Assumptions Audit row 1 (line 98).

4. **Brief's recommendation of Option C (V1 Beta) under human-implementation cost model AND the cost-model flip under AI implementation** → captured in ADR-019 §Context line 31 ("The decision below re-runs the same trade-off with the revised cost model") and §Synthesis line 66 ("It is the wrong position for a team where AI-implementation collapses the cost half of the cost-benefit"). The brief's own Option C analysis (§7 lines 203–212) is mirrored in ADR-019 §Alternatives Considered Option C (lines 82–86).

5. **Brief's Option B steel-man (industry-norm node-pty-only)** → captured in ADR-019 §Antithesis line 62 and §Alternatives Considered Option B lines 76–80.

6. **Brief's Option A analysis (Rust sidecar in V1 scope)** → adopted as ADR-019's primary Decision (line 46) and steel-manned in §Alternatives Considered Option A lines 70–74.

7. **Brief's Option D (`useConptyDll: true` flag)** → captured in ADR-019 §Alternatives Considered Option D lines 88–92, with the Tripwire 3 cross-reference (line 165).

8. **Brief's IPC design recommendation (Content-Length framing over stdio, JSON control + binary data channel)** → captured in ADR-019 §Decision item 5 (line 49); §Assumptions Audit row 4 (line 101).

9. **Brief's distribution recommendation (`@esbuild/*` platform-package pattern)** → captured in ADR-019 §Decision item 6 (line 50).

10. **Brief's signing recommendation (Azure Trusted Signing preferred; EV cert fallback)** → captured in ADR-019 §Decision item 7 (line 51), §Assumptions Audit row 3 (line 100), and §Failure Mode Analysis row 3 (line 109). NB: ADR-019 uses the term **"Azure Artifact Signing"** while the brief uses **"Azure Trusted Signing"** — these refer to the same MS service (rebranded; FAQ page at `learn.microsoft.com/en-us/azure/artifact-signing/faq` confirms). Not an error, but T12 may want to flag the naming alignment for editorial consistency.

11. **Brief's SmartScreen-reputation-pools-on-signer claim** → captured in ADR-019 §Decision item 8 (line 52) and §Consequences Positive (line 128).

12. **Brief's `PtyHost` interface as the platform-selection isolation point** → captured in ADR-019 §Decision item 4 (line 48), §Consequences Positive (line 127), and §Reversibility (line 117).

13. **Brief's "node-pty stays primary on macOS/Linux" recommendation** → captured in ADR-019 §Decision item 3 (line 47) and §Consequences Positive (line 126).

14. **Brief's tripwire cluster (sidecar-Sev-1, signing-blocked, node-pty-v1.2.0-ships-clean)** → captured in ADR-019 §Tripwires items 1–3 (lines 163–165). T12 should NOT re-embed these as new content.

---

## §3 — Unique-Content Risk

This section lists analytic claims in the brief that are **NOT YET present** in ADR-019 body prose. Non-empty list = those claims need separate body-prose addition (or explicit decision-not-to-absorb) before bl-052 deletion is safe at task T20.

The following claims appear in the brief but have **no corresponding prose** in ADR-019. Each is annotated with whether the claim is load-bearing for the Decision (= must be absorbed before delete) or non-load-bearing (= safe to drop with the brief).

1. **GitHub Actions Windows-vs-Linux pricing analysis** (brief §4 lines 122–138; runners $0.006 Linux vs $0.010 Windows post-2026-01-01; ~1.67× multiplier; flat $0.002/min cloud-platform charge; 1.5–3× wall-clock for Windows native rebuilds).
   - **Status in ADR-019:** Not present. ADR-019 §Reversibility line 116 mentions "CI cross-compile matrix" and §Negative Consequences line 134 says "Cross-compile CI infrastructure required across 5 platform targets," but the cost framing and per-minute pricing are absent.
   - **Load-bearing for Decision?** No. The brief's CI cost analysis was a sub-argument for Option C (V1 Beta) under the human-cost model; under the AI-cost model that rules ADR-019, CI cost is a one-time ops setup, not a decision-flipping cost. **Safe to drop with the brief**, OR T12 can add citation rows 35 and 36 to anchor the CI cost framing if an editorial preference is to keep the primary-source link.
   - **Recommendation:** Add citation rows 35/36 to ADR-019 table; do NOT add new body prose.

2. **Antivirus / EDR interaction risk (SentinelOne flagging Electron as security threat; Windows Defender flagging detached-spawn as `Trojan:Win32/SuspExec.SE`)** (brief §5 lines 161–163).
   - **Status in ADR-019:** Not present. No mention of AV/EDR risk anywhere in ADR-019.
   - **Load-bearing for Decision?** Partially. The AV/EDR risk applies regardless of the chosen PTY backend (it's about distributed-binary-spawn behavior, not about PTY API choice), so it doesn't change Option A vs B vs C. But it IS a Windows-tier-specific risk class that the ADR's §Failure Mode Analysis omits. **Recommendation:** T12 SHOULD add a one-row entry to ADR-019 §Failure Mode Analysis naming "AV/EDR false-positive on detached spawn or daemon polling" with detection (telemetry on user-reported AV blocks) and mitigation (signing reputation + documentation of expected AV warnings); cite vscode#239184 (row 22) and node-pty#887 comment thread.

3. **Reference-app comparative table (Zed / Warp / Wave / VS Code / Cursor / Windsurf / Tabby / Claude Code) including Zed's Rust-native and Warp's "Rust-native but still Beta" data points** (brief §2.5 lines 73–87).
   - **Status in ADR-019:** Partially present. ADR-019 lines 14 and 62 list "VS Code, Cursor, Windsurf, Tabby, Wave, Claude Code" as the industry-norm set. But Zed (the closest precedent for the chosen Rust PTY architecture) and Warp (the only counterexample — Rust-native chose Beta) are NOT cited.
   - **Load-bearing for Decision?** Yes for Zed; partially for Warp. Zed is the strongest "Rust PTY ships GA on Windows" precedent the brief surfaces, and ADR-019 §Synthesis (line 66) leans on the Decision being implementable; citing Zed's day-one Windows GA strengthens that. Warp is the only counterexample worth a §Antithesis citation. **Recommendation:** T12 SHOULD add citation rows 25 (Zed), 26 (Zed terminal core), 27 (Warp), and 28 (Wave) to ADR-019 table. Optionally extend ADR-019 §Antithesis line 62 with a one-clause acknowledgment "even Rust-native Warp ships Windows in Beta" — this is editorial; not strictly required.

4. **Brief §6 gotchas: Ctrl+C propagation, process-tree kill via `taskkill /T`, WSL2 interop scope ("Windows GA = Windows native; not WSL2 inside-launch"), Electron `will-quit` proactive PTY-kill ordering** (brief §6 lines 167–177).
   - **Status in ADR-019:** Partially present. `useConptyDll: true` pitfall is captured in ADR-019 §Alternatives Option D (lines 88–92). Process-tree-kill is implicit via `node-pty#437` citation. **NOT** captured: Ctrl+C propagation requires daemon-layer work; WSL2 scope boundary; Electron shutdown ordering for proactive PTY kill before `will-quit`.
   - **Load-bearing for Decision?** No for the tier/backend decision itself; YES for downstream Plan-024 (Rust PTY sidecar plan) and Plan-001 (shared session core) which need to know these are daemon-layer responsibilities, not PTY-backend responsibilities.
   - **Recommendation:** T12 should NOT add these to ADR-019 body — they are implementation gotchas for Plan-024, not Decision rationale. Verify Plan-024 captures them (out of scope for T9; flag for T12 cross-check). The citations rows 13 (`#167`) and 17 (`#242891`) would land in ADR-019 table even if the gotcha prose stays in Plan-024.

5. **Brief §2.3 fork-ecosystem signal: `@homebridge/node-pty-prebuilt-multiarch`, `@lydell/node-pty` cited in Codex/Gemini stack traces** (brief lines 53–56).
   - **Status in ADR-019:** Not present.
   - **Load-bearing for Decision?** No. The fork ecosystem is a sub-argument for "node-pty pin-the-version isn't a clean fix"; this argument is already absorbed into ADR-019 §Alternatives Option B "Why rejected" (line 80) which calls pin-the-version "a workaround, not a fix." The fork-ecosystem detail is illustrative, not necessary.
   - **Recommendation:** T12 may add citation row 34 to the table; do NOT add body prose. **Safe to drop with the brief.**

6. **Brief §2.4 Bun/Deno/Go-pty PTY-alternative survey** (brief lines 59–71).
   - **Status in ADR-019:** Not present (only `portable-pty` from this survey is cited).
   - **Load-bearing for Decision?** No. ADR-019's Decision picks `portable-pty` and doesn't need to enumerate the rejected alternatives (`creack/pty`, `winpty-rs`, `aymanbagabas/go-pty`, `bun:pty`).
   - **Recommendation:** **Safe to drop with the brief.** T12 may optionally add rows 31 (go-pty), 32 (creack/pty), 33 (winpty-rs) for completeness, but doing so doesn't strengthen the Decision; can be skipped.

7. **Brief §3.1 "no shipping headline Electron devtool runs a Rust sidecar specifically for PTY" inference** (brief line 102; this is the brief's marked-inference claim that the project would be slightly pioneering).
   - **Status in ADR-019:** Partially present. ADR-019 §Antithesis line 62 says "Adopting a Rust sidecar makes this project distinct from the norm in a way that introduces real ongoing costs"; this implicitly captures the inference but doesn't say "no peer ships this exact pattern."
   - **Load-bearing for Decision?** Yes — it's part of the brief's argument FOR Option C (V1 Beta) on the grounds that A is unprecedented. ADR-019 absorbed it implicitly via the Antithesis steel-man, which is sufficient.
   - **Recommendation:** **Already absorbed.** No T12 action needed.

8. **Brief §5 "Windows is 15% of users but 40% of issues" disclaimer** (brief lines 158–159; the brief explicitly marks this as an inference NOT supported by primary source).
   - **Status in ADR-019:** Not present.
   - **Load-bearing for Decision?** No. The brief itself flagged this as not citeable. **Safe to drop with the brief.**

9. **Brief §1.3 "Codex's specific fragility vs. our smaller engineering capacity" framing as the live question** (brief line 25).
   - **Status in ADR-019:** Captured via §Synthesis line 66's "load-bearing fact is the Codex first-party issue."
   - **Recommendation:** **Already absorbed.** No T12 action needed.

### §3 summary (verdict for T20 deletion-safety)

**§3 verdict:** Not empty. Three items require T12 action before bl-052 can be safely deleted at T20:

- **Item 2 (AV/EDR):** REQUIRES BODY PROSE addition to ADR-019 §Failure Mode Analysis (one row) per recommendation above. Otherwise this risk class disappears from the corpus when bl-052 deletes.
- **Item 3 (Zed/Warp reference apps):** REQUIRES citation row additions (rows 25–28) to ADR-019 §Research Conducted table. Optional one-clause body-prose extension to §Antithesis acknowledging Warp counterexample.
- **Item 4 (gotchas):** REQUIRES Plan-024 to have absorbed the gotchas (Ctrl+C, taskkill, WSL2 scope, Electron will-quit ordering). T9's scope is bl-052→ADR-019; T12 must cross-check Plan-024 absorbance OR file a follow-up before T20 deletes.

The remaining items (1, 5, 6, 7, 8, 9) are either already absorbed or non-load-bearing and safe to drop.

**ABSORPTION CHECK: NOT FULLY CLEAN.** Items 2, 3, 4 above represent unique-content risk that T12 must address (or explicitly accept) before T20 deletes bl-052.

---

## Anomalies and Notes for T12

1. **Two in-text-only citations missing from brief §9** (rows 40 and 41 above): `microsoft/node-pty#490` and `microsoft/node-pty#715` are mentioned in body prose (lines 99 and 137 respectively) but not consolidated in §9. URLs are reconstructed from the standard pattern; T12 should verify before embedding.
2. **One §9 citation missing its URL** (row 39 above): `nodejs/node#62125` (brief §9 line 308) lists only the issue number with no URL. T12 should verify the reconstructed URL `https://github.com/nodejs/node/issues/62125` resolves.
3. **DeepWiki third-party mirror** (row 26 above): `https://deepwiki.com/zed-industries/zed/9.1-terminal-core` is a third-party mirror of Zed's docs, not the upstream source. T12 should consider citing the upstream zed-industries/zed repo or marking the row as "(third-party mirror)".
4. **Naming alignment "Azure Trusted Signing" vs "Azure Artifact Signing"**: brief uses "Azure Trusted Signing" (line 111), ADR-019 uses "Azure Artifact Signing" (lines 51, 100). The MS service was renamed; the FAQ URL at `learn.microsoft.com/en-us/azure/artifact-signing/faq` resolves either way as of the survey date. ADR-019's terminology is the current MS name; brief's is the prior. T12 may flag for editorial consistency review; not a citation-level issue.
5. **Brief §3.3 cost estimate** (3–5 engineer-weeks): no primary-source citation; based on inference. Already absorbed implicitly into ADR-019 §Context line 31 and §Alternatives Option C "Why rejected" line 86 ("3–5 engineer-weeks of Rust work"). Not a citation-survey concern.
6. **Brief §3.2 Tauri externalBin pattern reference** (line 110): co-cited with row 9 (Tauri v2 sidecar docs). Already in ADR-019 table line 182.
7. **Brief section §1.2 "Electron was chosen over Tauri/Wails… because WebKitGTK has no WebAuthn"**: not a bl-052 citation — that's an ADR-016 citation already absorbed there. No T9 action.

---

*End of T9 survey. Next task: T12 (embed selected bl-052 citations into ADR-019 §Research Conducted table per HIGH/MED priority and add §3 unique-content body prose for items 2, 3, 4).*
