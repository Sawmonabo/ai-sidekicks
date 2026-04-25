# Embed Log — Plan-024 (T-bl-052-Plan-024)

**Task:** Embed bl-052 §6 Windows-implementation gotchas (4 items) into Plan-024 before T20 deletes the brief; consider ADR-019 cross-refs as scope-conditional.
**Date:** 2026-04-25
**Plan target:** `docs/plans/024-rust-pty-sidecar.md`
**Source brief:** `docs/research/bl-052-windows-tier-research.md` §6 (slated for deletion at T20)
**Related survey:** `docs/audit/research-deletion-surveys/bl-052-survey.md` (T9 output) — survey §3 Item 4 explicitly flagged the Plan-024 gotcha-gap as the deletion-blocker this task addresses
**Related embed log:** `docs/audit/research-deletion-surveys/embed-log-adr-019.md` (T12 output) — its (e) section pre-flagged this gap; "MISSING" verdict on all 4 gotchas at T12 grep time

---

## (a) Section structure decision

**Pre-edit Plan-024 section list:**
- `## Goal` (line 15)
- `## Scope` (line 19)
- `## Non-Goals` (line 31)
- `## Preconditions` (line 39)
- `## Target Areas` (line 48)
- `## Data And Storage Changes` (line 63)
- `## API And Transport Changes` (line 67)
- `## Implementation Steps` (line 72)
- `## Windows Signing — Two Parallel Tracks` (line 103)
- `## Parallelization Notes` (line 126)
- `## Test And Verification Plan` (line 134)
- `## Rollout Order` (line 144)
- `## Rollback Or Fallback` (line 153)
- `## Risks And Blockers` (line 159)
- `## Done Checklist` (line 170)
- `## Tier Intent` (line 183)
- `## References` (line 187)

**No existing "Windows Implementation Gotchas" or equivalent section.** The closest existing Windows-specific section is `## Windows Signing — Two Parallel Tracks` (signing concerns).

**Decision:** Create a new top-level `## Windows Implementation Gotchas` section, inserted **between `## Implementation Steps` (which ends at the previous line 101 ending with step 15) and `## Windows Signing — Two Parallel Tracks` (which begins at the previous line 103)**. Rationale (advisor-confirmed):
- Both adjacent sections are Windows-specific implementation concerns. Gotchas inform "how to write the code"; signing addresses "how to ship the code." Natural flow.
- Implementation Steps end with the daemon consumer wire-up; gotchas are the next logical "things to know about the daemon-side wiring" content.
- Signing comes after gotchas because signing is a packaging / distribution concern, downstream of code correctness.

**Final post-edit section list** (delta from above):
- `## Implementation Steps` (line 72; unchanged start)
- **NEW: `## Windows Implementation Gotchas` (line 103)** — new section with 4 numbered subsections at lines 107, 118, 127, 135
- `## Windows Signing — Two Parallel Tracks` (line 144; shifted by +41 lines)
- subsequent sections all shifted by +41 lines

---

## (b) Gotcha-by-gotcha embed locations

| # | Gotcha | Plan-024 subsection | Final line range | External citation pointer |
|---|--------|---------------------|-------------------|---------------------------|
| 1 | Ctrl+C signal propagation on Windows — `GenerateConsoleCtrlEvent` semantics; `CTRL_C_EVENT` vs `CTRL_BREAK_EVENT`; child-process group attachment matters | `### 1. Ctrl+C signal propagation on Windows` | 107–116 | [microsoft/node-pty#167](https://github.com/microsoft/node-pty/issues/167) — referenced inline at the daemon-layer-obligation paragraph and mirrored in `## References` |
| 2 | `taskkill /T` tree-kill behavior — sidecar must use tree-kill (not single-PID kill) on Windows | `### 2. \`taskkill /T\` tree-kill behavior` | 118–125 | [microsoft/node-pty#437](https://github.com/microsoft/node-pty/issues/437) — already in `## References` (pre-existing); enriched the existing row to name "Gotcha 2" linkage |
| 3 | WSL2 path translation scope — UNC paths vs POSIX paths; sidecar's responsibility boundary; `wslpath` availability | `### 3. WSL2 path translation scope` | 127–133 | No external URL in bl-052 §6 (brief framed this as a scope decision, not as a citation-bearing implementation detail). No citation row added per advisor; embed captures both the operative scope decision and the operative implementation guidance |
| 4 | Electron `will-quit` ordering vs sidecar shutdown — sidecar cleanup must register before Electron's `will-quit`; race-window between renderer-process termination and sidecar drain | `### 4. Electron \`will-quit\` ordering vs sidecar shutdown` | 135–142 | [microsoft/node-pty#904](https://github.com/microsoft/node-pty/issues/904) — already in `## References` (pre-existing); enriched the existing row to name "Gotcha 4" linkage |

**Substance verification:** Each subsection captures the bl-052 §6 substance plus implementation-grade detail. The brief was terse (one bullet per gotcha at lines 167-178); the embed expands each to the level a Plan-024 author needs to actually write the code without re-reading bl-052 (since bl-052 will be deleted at T20). Daemon-layer-vs-sidecar-layer responsibilities are explicitly named in each subsection.

**Gotcha-3 framing note:** Per advisor reconciliation, bl-052 §6 framed WSL2 as a *scope decision* ("Windows GA = Windows native; launching from inside WSL is user-support") more than as an implementation-only concern. The embed preserves both the scope-level operative ("user-supported, not first-class in V1") AND the implementation-level operative ("sidecar does not translate paths between Windows-native and WSL2 namespaces") so the Plan-024 author gets unified guidance.

---

## (c) Citations added to `## References`

**Pre-edit `## References` row count:** 25 entries (lines 188–211 in pre-edit Plan-024).
**Post-edit `## References` row count:** 26 entries (lines 230–253 in post-edit Plan-024).

**One new citation row added** (Gotcha 1's external source was the only entry not already present in pre-edit Plan-024):
- [microsoft/node-pty#167](https://github.com/microsoft/node-pty/issues/167) — sending a signal to all processes in the process group of the pts; Ctrl+C / SIGINT propagation does not reach process group on Windows (cited by Gotcha 1: Ctrl+C signal propagation on Windows)

**Two existing rows enriched** (no row count change; gotcha linkage suffix appended to existing description):
- [microsoft/node-pty#904](https://github.com/microsoft/node-pty/issues/904) — pre-edit description "SIGABRT on Electron exit"; post-edit description "SIGABRT on Electron exit (cited by Gotcha 4: Electron `will-quit` ordering vs sidecar shutdown)"
- [microsoft/node-pty#437](https://github.com/microsoft/node-pty/issues/437) — pre-edit description "`ptyProcess.kill()` hangs on Windows"; post-edit description "`ptyProcess.kill()` hangs on Windows; process-tree kill not reliable (cited by Gotcha 2: `taskkill /T` tree-kill behavior)"

**Top 3 citation actions (by importance):**
1. **NEW** `microsoft/node-pty#167` — primary external source for Gotcha 1, was not in pre-edit Plan-024.
2. **ENRICHED** `microsoft/node-pty#904` — already in Plan-024 References; gotcha-linkage suffix added so Plan-024 author can find the citation when reading Gotcha 4.
3. **ENRICHED** `microsoft/node-pty#437` — same pattern; already in References, gotcha-linkage suffix added for Gotcha 2.

**Rows deliberately not added:**
- WSL2 / `wslpath` primary source: bl-052 §6 did not cite an external URL for WSL2 path translation. Microsoft Docs for `\\wsl.localhost\` UNC paths and `wslpath` exist (e.g., `https://learn.microsoft.com/en-us/windows/wsl/filesystems`) but adding them would be surfacing-from-thin-air rather than embedding bl-052 content. Plan-024 author can add such citations as part of implementation work if needed; not within this task's scope.

---

## (d) ADR-019 cross-ref decisions

**Task scope (verbatim from prompt):** "Check if Item 2 (AV/EDR) overlaps with Gotcha 2 (taskkill /T)... Check if Item 3 (Zed/Warp/Wave PTY-DLL) overlaps with Gotcha 1 (Ctrl+C semantics)... DO NOT add new ADR-019 citations; DO NOT modify ADR-019 body-prose substance. Cross-refs ONLY."

**Cross-refs added: 0.**

**ADR-019 Item 2 (AV/EDR row in §Failure Mode Analysis, line 112) vs Plan-024 Gotcha 2 (`taskkill /T`):** No overlap.
- ADR-019 Item 2 describes AV/EDR **behavioral detection** of detached-spawn patterns and liveness-poll cadence — pattern-recognition concerns at the binary-identity / runtime-behavior level. The cited bugs (`vscode#239184`, `node-pty#887` comment thread) are about SentinelOne and Windows Defender flagging *the spawn pattern itself* as malicious, not about the OS-level outcome of the spawn-and-kill operations.
- Plan-024 Gotcha 2 (`taskkill /T` tree-kill) is about **correctly reaping process trees** on session teardown — process-management correctness, with the failure mode being orphaned grandchildren rather than AV interference.
- The two concerns are distinct: AV detection is observed at binary spawn / network-pattern; tree-kill is an OS-level process-management primitive. A correct `taskkill /T` does not avoid AV detection, and a successful AV whitelist does not change tree-kill semantics.
- **Decision: No cross-ref added.** Documented here for audit trail.

**ADR-019 Item 3 (Zed/Warp/Wave precedents, body-prose at lines 62 and 66) vs Plan-024 Gotcha 1 (Ctrl+C semantics):** No overlap.
- ADR-019 Item 3 is precedent-citation prose validating the architectural choice (Rust PTY backend ships GA on Windows per Zed; Electron-plus-sidecar topology ships per Wave; Warp counter-example for Beta-on-Windows risk). These are backend-choice precedents.
- Plan-024 Gotcha 1 (Ctrl+C signal propagation) is about **translating signal semantics** in `PtyHost.kill()` — implementation-detail in the sidecar's signal-handling code. Independent of which backend is chosen (every Windows-PTY backend faces the same `GenerateConsoleCtrlEvent` semantics).
- The two concerns are distinct: Item 3 is "should we use this architecture"; Gotcha 1 is "given the architecture, how does signal-translation work."
- **Decision: No cross-ref added.** Documented here for audit trail.

**Net ADR-019 changes from this task: 0 lines modified.** ADR-019 left untouched per scope. Plan-024 §Windows Implementation Gotchas contains an internal cross-ref to `ADR-019 §Failure Mode Analysis row 4` at the end of Gotcha 4, but that cross-ref is *outbound* from Plan-024 (referencing ADR-019); ADR-019 itself is unchanged.

---

## (e) Verification grep result

```text
$ grep -n "research/bl-052" docs/plans/024-rust-pty-sidecar.md
NO MATCHES
```

**CLEAN.** Plan-024 contains zero `research/bl-052` pointers. T20 can safely delete `docs/research/bl-052-windows-tier-research.md` without leaving dangling links from Plan-024.

Cross-checked against the literal string `bl-052` (no path prefix) for completeness — also zero matches in Plan-024. (Per T12 embed-log §(f), the literal `BL-052` may appear in other corpus files as a backlog-item identifier; that is unrelated to file-path-pointer scope.)

---

## (f) Anomalies and out-of-scope observations

1. **bl-052 §6 has additional gotchas beyond the 4 named in this task.** The brief §6 also names: Unicode/IME in TUI (`vscode#255285`), `useConptyDll: true` regression (`#894`), and `spawn locks cwd` (`#647`). These are NOT named as the 4 task-scope gotchas; they are addressed elsewhere in Plan-024:
   - `useConptyDll: true` is captured at Plan-024 line 35 (`## Non-Goals`) and line 240 (`## References`).
   - `spawn locks cwd` (`#647`) is in `## References` line 241.
   - Unicode/IME (`vscode#255285`) is not in Plan-024; it's in ADR-019 §Research Conducted only. Whether this needs Plan-024 absorption is a question for a separate task — out of scope here.
2. **Gotcha 4 internal cross-ref to Plan-001:** The Gotcha 4 subsection notes that `will-quit` ordering responsibility is owned by Plan-001 (shared session core), not Plan-024. The cross-reference is informational and does not commit Plan-001 to specific edits — the Plan-001 author handles this when authoring session-lifecycle code. Whether Plan-001 needs corresponding documentation absorption is a question for a separate task — out of scope here.
3. **No primary URL for WSL2 / `wslpath` was embedded.** bl-052 §6 did not include an external citation for WSL2 (the brief framed it as a scope decision derived from the reference-app survey of "does the project commit to WSL interop"). Microsoft Docs URLs for `\\wsl.localhost\` UNC paths and `wslpath` exist but adding them would be surface-creation, not embed-from-source. Flagged for the Plan-024 author to add citations during implementation as needed.
4. **ADR-019 §Failure Mode Analysis row 4 cross-reference** in Gotcha 4 references a CI-regression row, not an `will-quit`-ordering row. The cross-ref is exclusion-flavored ("the named row is unrelated"); included so the Plan-024 author searching ADR-019's Failure Mode Analysis for `will-quit` content does not assume row 4 is the relevant one. The actual "will-quit"-class concern is owned at the daemon layer (Plan-001 / Plan-024 wiring) per ADR-019 §Decision item 4 (`PtyHost` interface). The cross-ref preserves discoverability across docs.
5. **No new substance was created.** Each gotcha subsection's content traces back to bl-052 §6 lines 167-178 (the verbatim source) or to standard Windows Console API documentation (general knowledge of `GenerateConsoleCtrlEvent` / `taskkill /T` / `wslpath`). No claim is made beyond what bl-052 supports plus standard-library-reference knowledge.

---

*End of Plan-024 embed log. Next task in research-deletion arc: T19 (sweep gate for citation-flow integrity), then T20 (delete `docs/research/bl-052-windows-tier-research.md`). Plan-024 gotcha-gap pre-condition (T12 embed log §(e) flagged it; this task closes it) is now resolved.*

---

## T19 Spillover Augmentation

**Date:** 2026-04-25
**Verifier:** Opus 4.7 via T19 subagent
**Trigger:** T19 Phase 1.5 verification of the 3 spillover gotchas T26 §(f) flagged out-of-scope: (a) Unicode/IME `vscode#255285`, (b) `useConptyDll` regression, (c) `spawn locks cwd` `node-pty#647`.

### Spillover-by-spillover verdict

| # | Gotcha (bl-052 §6 line) | Coverage in Plan-024 + ADR-019 | Implementation guidance in bl-052 §6? | T19 action |
|---|--------------------------|--------------------------------|---------------------------------------|------------|
| (a) | Unicode/IME (`vscode#255285`, line 171) | ADR-019 §Research Conducted line 189 captures the same failure-mode classification. Plan-024 not present. | bl-052 §6 line 171 is purely "this happens" classification; no `Mitigation:` clause. | **No augmentation.** ADR-019 line 189 captures classification at equal depth; nothing implementable to lose at deletion. |
| (b) | `useConptyDll` regression (`node-pty#894`, line 176) | Plan-024 line 35 §Non-Goals defers per ADR-019 Tripwire 3; Plan-024 References line 239 carries the PowerShell 7 regression context inline. | bl-052 §6 line 176 says "do not flip this on blind — it regresses PowerShell 7 today per `microsoft/node-pty#894`." | **No augmentation.** Plan-024 captures the regression context at the §Non-Goal level + reference-row description; the deferral decision is anchored to the right primary source. |
| (c) | `spawn locks cwd` (`node-pty#647`, line 174) | ADR-019 §Research Conducted line 180 classifies as "blocks worktree workflows." Plan-024 References line 241 carries the issue link only. **No implementation guidance anywhere.** | bl-052 §6 line 174 has implementation guidance: "spawn from a stable parent dir, pass the target as `env.CWD` or `cd &&`." | **EMBED.** This is a clean implementation-guidance gap; worktree-swap is a real Plan-001 daemon concern. |

### (c) Embed details

**Location:** `docs/plans/024-rust-pty-sidecar.md` §Windows Implementation Gotchas → new `### 5. Spawn locks cwd on Windows` subsection.
**Insertion point:** between previous Gotcha 4 (Electron `will-quit` ordering) and §Windows Signing — Two Parallel Tracks. Section list now:
- `### 1. Ctrl+C signal propagation on Windows` (lines 107–116; unchanged)
- `### 2. \`taskkill /T\` tree-kill behavior` (lines 118–125; unchanged)
- `### 3. WSL2 path translation scope` (lines 127–133; unchanged)
- `### 4. Electron \`will-quit\` ordering vs sidecar shutdown` (lines 135–142; unchanged)
- **NEW:** `### 5. Spawn locks cwd on Windows` (lines 144–149)
- `## Windows Signing — Two Parallel Tracks` (line 151; was 144 pre-edit; shifted by +7 lines)
- subsequent sections all shifted by +7 lines

**Section preamble updated:** Plan-024 line 105 "Four Windows-specific implementation concerns…" → "Five Windows-specific implementation concerns…" (count rolled forward).

**Citations added (References section):**
- **0 new rows.** [microsoft/node-pty#647](https://github.com/microsoft/node-pty/issues/647) is the only external primary source for Gotcha 5 and was already in Plan-024 References at the pre-edit line 241 (post-edit line 248); the existing row was **enriched** with `(cited by Gotcha 5: Spawn locks cwd on Windows; blocks worktree workflows)` suffix per the same convention T26 used for `#437` (Gotcha 2) and `#904` (Gotcha 4).

**Implementation guidance preserved in embed:**
- Mitigation pattern (a): stable-parent-dir spawn + `cd <worktree-path> && ` shell prefix.
- Mitigation pattern (b): stable-parent-dir spawn + `env.CWD=<worktree-path>` propagation.
- Daemon-layer responsibility named: `PtyHost.spawn(spec)` translates `spec.cwd` → (stable parent dir, prefixed command) tuple before forwarding to `RustSidecarPtyHost`.
- NodePtyHost-fallback callout: same Windows-OS-level lock applies regardless of backend; the daemon-layer translation is OS-level concern, not backend-specific.
- Cross-reference to ADR-019 §Research Conducted row classifying the failure mode + Plan-001 ownership of the daemon-layer translation step.

**Cross-doc surface:** No edits to ADR-019 (still classifies the failure mode at line 180 only); no edits to Plan-001 (the cross-reference notes Plan-001 owns the daemon-layer translation as informational; Plan-001 author handles when authoring session-spawn code). No new external citation rows added in any doc (the `#647` URL was already present in both Plan-024 and ADR-019 references, just with one-line classification descriptions).

**Substance check:** Mitigation-pattern text traces directly to bl-052 §6 line 174 (`spawn from a stable parent dir, pass the target as env.CWD or cd &&`) plus standard Windows file-system semantics (`ERROR_SHARING_VIOLATION` from cwd lock is documented in MSDN's CreateFile / file-locking class reference; not net-new claim). No surface-from-thin-air content.

### Verification grep result

```text
$ grep -n "research/bl-052" docs/plans/024-rust-pty-sidecar.md
NO MATCHES
```

**CLEAN.** Plan-024 still contains zero `research/bl-052` pointers post-spillover-embed. T20 deletion-readiness confirmed.

---

## T19 Cross-Reference: PASS

Verified 2026-04-25 by Opus 4.7 via T19 sweep gate. Embed-log claims cross-checked against `git diff main..HEAD -- docs/plans/024-rust-pty-sidecar.md` (covers both T26's 4-gotcha embed and T19's spillover Gotcha 5).

**Spot-checks:**
- §Windows Implementation Gotchas section: lives between §Implementation Steps and §Windows Signing — Two Parallel Tracks per embed log §(a). Match.
- 5 gotcha subsections present at the expected positions (1: Ctrl+C / line 107; 2: taskkill /T / line 118; 3: WSL2 / line 127; 4: Electron will-quit / line 135; 5: spawn locks cwd / line 144). The 5th was added by this T19 spillover augmentation.
- Section preamble text: "Five Windows-specific implementation concerns…" (rolled forward from "Four" by this T19 augmentation).
- §References section: 26 entries; T26 embed log claimed "Post-edit row count: 26"; my T19 augmentation added 0 new rows and enriched the existing `node-pty#647` description with `(cited by Gotcha 5: Spawn locks cwd on Windows; blocks worktree workflows)`. Match.
- Diff stat: 56 insertions / 3 deletions; consistent with 4-gotcha embed (T26: ~41 lines) + 5th gotcha embed (T19: ~7 lines) + 2 reference-row enrichments.
- Final-state grep `docs/research/|\.\./research/|bl-052` against Plan-024 returns zero matches.

**Verdict: PASS.** Plan-024 ready for T20 deletion of `docs/research/bl-052-windows-tier-research.md`.
