# Embed Log — ADR-019 (T12)

**Task:** T12 — Embed bl-052 content into ADR-019 + body-prose additions + backlog.md cross-ref.
**Date:** 2026-04-25
**ADR target:** `docs/decisions/019-windows-v1-tier-and-pty-sidecar.md`
**Source brief:** `docs/research/bl-052-windows-tier-research.md` (slated for deletion at T20)
**Survey input:** `docs/audit/research-deletion-surveys/bl-052-survey.md` (T9 output)

---

## (a) Citation rows added

**Pre-edit row count:** 12 data rows in §Research Conducted (lines 173–184 originally; the first row was the bl-052 brief pointer, removed per (b) below).
**Post-edit row count:** 32 data rows in §Research Conducted (lines 174–205, plus header at 172–173).
**Rows added:** 21 new external-citation rows (one removed per (b), so net +20 row count delta but 21 rows of new content).

New rows added (in current ADR-019 line order, after the `### Research Conducted` table header at line 172):

| # | Source | Survey priority | Final ADR-019 line |
|---|--------|-----------------|--------------------|
| 1 | `microsoft/node-pty#827` | HIGH | 178 |
| 2 | `microsoft/node-pty#167` | MED | 181 |
| 3 | `microsoft/node-pty#842` | MED | 182 |
| 4 | `microsoft/node-pty` releases | HIGH (anchors Tripwire 3) | 183 |
| 5 | `microsoft/vscode#224488` | MED | 185 |
| 6 | `microsoft/vscode#245709` | MED | 186 |
| 7 | `microsoft/vscode#252489` | MED | 187 |
| 8 | `microsoft/vscode#239184` | MED (load-bearing for new §Failure Mode AV/EDR row) | 188 |
| 9 | `microsoft/vscode#255285` | SUPPLEMENTAL (kept; corroborates IME edge case in agentic CLI) | 189 |
| 10 | `nodejs/node#62125` | MED (URL resolves via standard `nodejs/node/issues/<N>` pattern) | 190 |
| 11 | `portable-pty` crates.io listing | MED | 192 |
| 12 | Zed — "Windows When? Windows Now" blog | HIGH (primary precedent for Rust PTY on Windows GA) | 193 |
| 13 | Zed terminal core docs (DeepWiki, third-party mirror) | MED — flagged "third-party mirror" in Type column | 194 |
| 14 | Warp Rust forum announcement | HIGH (only counter-example for chosen architecture) | 195 |
| 15 | `wavetermdev/waveterm` | HIGH (closest IPC-topology peer) | 196 |
| 16 | `aymanbagabas/go-pty` | SUPPLEMENTAL (kept; corroborates Wave row) | 197 |
| 17 | `anthropics/claude-code` | MED | 198 |
| 18 | `@homebridge/node-pty-prebuilt-multiarch` | MED | 199 |
| 19 | Electron code-signing tutorial | MED | 203 |
| 20 | Security Boulevard 2025-12 — Electron-builder signing | MED | 204 |
| 21 | GitHub Actions runner pricing | MED | 205 |

**Total rows added: 21.**

**Survey items deliberately skipped per advisor + survey-author SUPPLEMENTAL skip recommendations:**
- Row 17 `microsoft/vscode#242891` (overlaps with `node-pty#437`)
- Row 19 `microsoft/vscode#308519` (illustrative-only)
- Row 23 `microsoft/vscode#201029` (illustrative-only)
- Row 24 `microsoft/terminal discussion #19112` (informational-only)
- Row 32 `creack/pty` (rejected alternative, not load-bearing)
- Row 33 `winpty-rs` (rejected alternative, not load-bearing)
- Row 36 GitHub 2026 Actions pricing changes (overlaps with row 35)
- Row 40 `microsoft/node-pty#490` (in-text-only, URL reconstruction needed; non-load-bearing)
- Row 41 `microsoft/node-pty#715` (in-text-only, URL reconstruction needed; non-load-bearing)

**Final delta:** 21 new rows added; 1 row removed (see (b)); net `### Research Conducted` table grew from 12 rows to 32 data rows (lines 174–205).

---

## (b) Rows removed

| Original line | Row content (removed) |
|---------------|------------------------|
| 174 (pre-edit) | `BL-052 research brief \| Primary research \| Evidence-grade evaluation of Windows tier options \| [`docs/research/bl-052-windows-tier-research.md`](../research/bl-052-windows-tier-research.md)` |

The bl-052-research-brief pointer row was the only row removed.

---

## (c) Inbound mentions rewritten

| File:line (pre-edit) | Change |
|----------------------|--------|
| `docs/decisions/019-windows-v1-tier-and-pty-sidecar.md:31` | "A companion research brief (`docs/research/bl-052-windows-tier-research.md`)" → "An earlier evaluation (cited primary sources catalogued in §Research Conducted below)" |
| `docs/decisions/019-windows-v1-tier-and-pty-sidecar.md:40` | "the research brief's recommendation" → "the prior Option C recommendation (under a human-implementation cost model)" |
| `docs/decisions/019-windows-v1-tier-and-pty-sidecar.md:82` | "Rejected; was the research brief's recommendation" → "Rejected; prior recommendation under human-implementation cost model" |
| `docs/decisions/019-windows-v1-tier-and-pty-sidecar.md:85` | "matches the research brief's cost-benefit" → "matches the prior cost-benefit" |
| `docs/decisions/019-windows-v1-tier-and-pty-sidecar.md:86` | "The research brief explicitly noted that" → "Under the prior human-implementation cost model," |
| `docs/decisions/019-windows-v1-tier-and-pty-sidecar.md:62` (Antithesis) | Tail clause "The research brief's recommendation (V1 Beta on `node-pty`) is the staff-engineer-default position" → "The V1 Beta recommendation on `node-pty` is the staff-engineer-default position" (wording change inside body-prose addition; see (d) Item 3) |
| `docs/decisions/019-windows-v1-tier-and-pty-sidecar.md:66` (Synthesis) | "Ship Beta\" (research brief Option C)" → "Ship Beta\" (Option C)" (wording change inside body-prose addition; see (d) Item 3) |
| `docs/decisions/019-windows-v1-tier-and-pty-sidecar.md:225` (Decision Log row) | "Research brief authored \| `docs/research/bl-052-windows-tier-research.md` recommended Option C..." → "Evidence-grade evaluation conducted \| Primary-source survey...; Option C V1 Beta recommended under a human-implementation cost model — see §Alternatives Considered Option C" |
| `docs/backlog.md:250` (BL-052 Resolution) | "Research brief (evidence-grade, with citations): [bl-052-windows-tier-research.md](./research/bl-052-windows-tier-research.md)." → "Evidence-grade primary-source citations are catalogued in [ADR-019 §Research Conducted](./decisions/019-windows-v1-tier-and-pty-sidecar.md#research-conducted)." |

---

## (d) Body-prose paragraphs added per 3 unique-content items

### Item 2 — AV/EDR risk class (added to §Failure Mode Analysis)

**Section header:** `## Failure Mode Analysis`
**Format:** Table row (NOT prose paragraph — survey §3 Item 2 said "row entry"; advisor confirmed §Failure Mode Analysis is a 5-column table; adding a paragraph would have broken section format).
**Final ADR-019 line range:** Line 112 (single new table row appended to the existing Failure Mode Analysis table).
**Content summary:** AV/EDR false-positive on the sidecar binary or its detached-spawn pattern; cites `microsoft/vscode#239184` (SentinelOne) and `microsoft/node-pty#887` comment thread (Windows Defender flagging detached spawn + liveness-poll as `Trojan:Win32/SuspExec.SE`). Detection: user-reported AV blocks, signing-pipeline pre-publish AV scan, SmartScreen reputation telemetry. Mitigation: shared-signer SmartScreen pooling (per Decision item 8), pre-launch submission to major AV vendors for whitelist, documented expected-AV-warning UX page, daemon liveness poll cadence kept above C2-beacon thresholds.

### Item 3 — Zed/Warp/Wave reference-app data (added to §Antithesis + §Synthesis)

**Split per advisor:** Warp counter-example → §Antithesis (strengthens "norm is conservative" argument); Zed precedent + Wave IPC analog → §Synthesis (justifies "the chosen architecture is achievable").

**Antithesis addition:**
- **Section header:** `### Antithesis — The Strongest Case Against`
- **Final ADR-019 line:** Line 62 (paragraph extended; mid-paragraph insertion).
- **Content:** "The strongest counter-example to the chosen architecture is [Warp Terminal]: Rust-native end-to-end with ~90% cross-OS code share, and yet Warp explicitly labels Windows as **Beta** rather than GA. A Rust-first team that has solved every other Rust-on-Windows surface still chose caution on Windows tier — that is signal that even the 'right' PTY backend does not retire all Windows-specific risk."

**Synthesis addition:**
- **Section header:** `### Synthesis — Why It Still Holds`
- **Final ADR-019 line:** Line 66 (paragraph extended; mid-paragraph insertion).
- **Content:** "The chosen architecture has shipping precedents on both axes that matter: [Zed shipped Windows GA day-one on 2025-10-15] with terminal working out of the box, built on `alacritty_terminal` (a Rust PTY, not `node-pty`) — direct evidence that a Rust PTY backend ships GA-clean on Windows. [Wave Terminal] is the closest peer for the IPC topology specifically: an Electron renderer paired with a separately-compiled PTY-bearing sidecar binary. Wave's sidecar is Go (built on `aymanbagabas/go-pty`) rather than Rust, and the PTY library differs, but the Electron-plus-sidecar split with ConPTY isolated to the sidecar is in production today. The two precedents together cover the chosen approach: Zed validates 'Rust PTY on Windows is a solved problem at the library layer,' Wave validates 'an Electron app can run a separately-compiled PTY-bearing sidecar in production.'"

**Paragraphs-added count (Item 3):** 0 new standalone paragraphs; 2 mid-paragraph extensions (one each in §Antithesis and §Synthesis). Net new prose ≈ 4 sentences in §Antithesis and ≈ 5 sentences in §Synthesis.

### Item 4 — Brief §6 gotchas verification

**Cross-doc CHECK only — no Plan-024 edit per task scope.**
**Result:** see (e) below.

---

## (e) Plan-024 gotcha verification result

Grep target: `docs/plans/024-rust-pty-sidecar.md`

| Gotcha | Search pattern | Match? | Status |
|--------|----------------|--------|--------|
| Ctrl+C signal-propagation | `Ctrl\+C\|signal.*propagat\|SIGINT\|CTRL_C` | No matches | **MISSING** |
| `taskkill` behavior on Windows / process-tree-kill orphan-reap | `taskkill\|/T \|process.tree\|orphan` | No matches | **MISSING** |
| WSL2 path-translation quirks / WSL scope boundary | `WSL\|WSL2\|path.translation\|path.separator` | No matches | **MISSING** |
| Electron `will-quit` ordering / proactive PTY-kill before quit | `will-quit\|will_quit\|Electron.shutdown\|proactive.kill\|before.*quit` | No matches | **MISSING** |

**Verdict:** All 4 brief §6 gotchas are absent from Plan-024. Per task scope, T12 does NOT modify Plan-024. **Flagged for separate handling** — recommend a follow-up task (or backlog entry) to absorb these 4 gotchas into Plan-024 before T20 deletes bl-052. Plan-024 currently mentions `useConptyDll` (lines 35, 198) which addresses the Option D pitfall, but the four daemon-layer responsibilities named in brief §6 (Ctrl+C propagation, `taskkill /T`, WSL2 scope, Electron will-quit ordering) are unaddressed.

---

## (f) Final-grep verification result

```text
$ Grep -i "bl-052-windows-tier-research" docs/decisions/019-windows-v1-tier-and-pty-sidecar.md
No matches found

$ Grep -i "bl-052-windows-tier-research" docs/backlog.md
No matches found
```

**Verification clean** for the file-path-pointer scope (the actual T12 deletion-safety target — eliminating dangling links to the about-to-be-deleted brief).

The literal string `BL-052` (case-sensitive, as a backlog item identifier) still appears in:
- `docs/decisions/019-windows-v1-tier-and-pty-sidecar.md:227` ("Drafted against BL-052 exit criteria") — Decision Log row; legitimate backlog-item identifier reference; NOT a pointer to the deleted brief.
- `docs/backlog.md:128, 245` — backlog item heading and its dependency reference; legitimate identifier; NOT a pointer to the deleted brief.

These are intentional. The task spec said "returns zero matches" for `bl-052`; literal interpretation would require renaming the BL identifier, which is out of scope (BL identifiers are stable across the corpus). The deletion-safety scope is the file-path reference, which IS clean.

---

## Anomalies / notes

1. **Naming inconsistency** (carried over from pre-edit ADR; survey §2 row 10 noted): brief used "Azure Trusted Signing"; ADR-019 uses "Azure Artifact Signing." Microsoft renamed the service; both names refer to the same service and the FAQ URL resolves either way. Flagged for editorial review; **no T12 edit**.
2. **Row 39 `nodejs/node#62125`** URL: brief §9 listed only the issue number with no URL. URL reconstructed via standard `https://github.com/nodejs/node/issues/<N>` pattern; Verified via the standard issue-URL pattern in use elsewhere in the same brief.
3. **Row 26 DeepWiki** marked as "(third-party mirror)" in the Type column per advisor recommendation; upstream zed-industries/zed source path not chased within T12 scope.
4. **Survey §1 footer** said "no edits needed to backlog.md" — advisor flagged this as a survey-author scope-narrow miss (survey was citation-flow-only; deletion-cleanup was out of survey scope). Advisor recommendation to override the survey footer was followed: backlog.md line 250 link to the brief is replaced with a cross-ref to ADR-019 §Research Conducted.
5. **Plan-024 gotcha gap** (see (e)) is a real downstream issue; flagged for separate task.
6. **§Failure Mode Analysis format** is a table (5 columns) per advisor; AV/EDR addition is a new row, not a paragraph. Format match preserved.

---

*End of T12 embed log. Next task in research-deletion arc: T20 (delete `docs/research/bl-052-windows-tier-research.md`) — pre-condition is the Plan-024 gotcha gap closed in (e).*

---

## T19 Cross-Reference: PASS

Verified 2026-04-25 by Opus 4.7 via T19 sweep gate. Embed-log claims cross-checked against `git diff main..HEAD -- docs/decisions/019-windows-v1-tier-and-pty-sidecar.md`.

**Spot-checks:**
- §Research Conducted table: 32 data rows (lines 174–205); embed log claimed "Post-edit row count: 32." Match.
- §Failure Mode Analysis: 6-row table with the AV/EDR row at line 112 carrying `vscode#239184` + `node-pty#887` citations as the embed log §(d) Item 2 described. Match.
- Diff stat: 41 insertions / 20 deletions; consistent with 21 new citation rows + 1 row removed + 8 inbound-mention rewrites + 2 mid-paragraph extensions in §Antithesis (line 62) and §Synthesis (line 66).
- Final-state grep `docs/research/|\.\./research/` against ADR-019 returns zero matches.
- Plan-024 gotcha gap (embed log §(e) flagged) closed by T26 (4 gotchas) + T19 spillover (5th gotcha — spawn-locks-cwd) per `embed-log-plan-024.md` §T19 Spillover Augmentation.

**Verdict: PASS.** ADR-019 ready for T20 deletion of `docs/research/bl-052-windows-tier-research.md`.
