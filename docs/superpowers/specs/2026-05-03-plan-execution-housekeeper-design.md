# Plan-execution Phase E auto-housekeeping subagent — design

| Field               | Value                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| Status              | approved                                                              |
| Drafted             | 2026-05-03                                                            |
| Owner               | user (a.sawmon@gmail.com)                                             |
| Implementer         | Claude Opus 4.7                                                       |
| Brainstormed via    | `superpowers:brainstorming` skill (terminal step is `writing-plans`)  |
| Source gap analysis | `.agents/tmp/plan-execution-housekeeping-gap-analysis.md` (transient) |

## 1. Background

### 1.1 The §6 NS-XX convention

PR #27 (merged 2026-05-02) introduced **Section 6 — Active Next Steps DAG** in `docs/architecture/cross-plan-dependencies.md`. §6 is the cross-plan dispatch tracker. Each tracked unit of work is an `NS-NN` entry.

The schema is defined by what's actually on disk. The four entries below — pasted verbatim from current HEAD, with line cites — span the full grammar range. Every schema rule, regex, parser, and emitter in the rest of this spec is derived from these four examples, not from imagination.

#### 1.1.1 Schema-by-example (verbatim, current HEAD)

> **Path-form note.** Markdown-link URLs in the verbatim NS blocks below are written from **this spec's location** (`docs/superpowers/specs/`) using `../../<tree>/...`, so the `cite-target-existence` pre-commit hook resolves them correctly. The actual on-disk text in `docs/architecture/cross-plan-dependencies.md` uses one fewer `../` (`../<tree>/...`), since it lives one directory shallower. Field structure, prose, headings, and `:NNN` line cites are otherwise verbatim against HEAD.

**NS-01 — `todo`, single-PR `code`, classic `Plan-NNN Phase N` heading** (`cross-plan-dependencies.md`:342-350):

```markdown
### NS-01: Plan-024 Phase 1 — Rust crate scaffolding

- Status: `todo`
- Type: code
- Priority: `P1`
- Upstream: none (Plan-024:267 — Phase 1 starts as soon as Plan-001 Phase 1 repo bootstrap is merged, which it is)
- References: [Plan-024](../../plans/024-rust-pty-sidecar.md):267-281, [ADR-019](../../decisions/019-windows-v1-tier-and-pty-sidecar.md), this document §4 (Plan-024 standalone)
- Summary: Scaffold the Rust PTY sidecar crate (T-024-1-1..5): workspace-root `Cargo.toml`, `packages/sidecar-rust-pty/{Cargo.toml,Cargo.lock,src/{main,framing,protocol,pty_session}.rs,tests/{framing_roundtrip,protocol_roundtrip,spawn_smoke}.rs}` + TS protocol mirror at `packages/contracts/src/pty-host-protocol.ts`. ~10 new files; no edits to existing TS source. Pins: `portable-pty 0.9`, `tokio 1.40`, `serde_with 3.7`, MSRV `1.85`, `cargo-zigbuild 0.22.2`. F-024-2-04 binds Phase 2/3 to Plan-001 T5.4 — Phase 1 itself is fully independent.
- Exit Criteria: T-024-1-1..5 merged; Linux `cargo build --release` + `cargo test --release` green; Plan-024 Phase 1 Done Checklist flipped.
```

**NS-04 — `todo`, multi-step `code` (cross-plan PR pair, internal 3-step sequence), heading WITHOUT `Phase N`** (`cross-plan-dependencies.md`:372-380; **snapshot date: 2026-05-03** — the verbatim block below reflects HEAD before §3a.1 PRs: shape rolls out. Once Plan-001 PR 1 of §10.1 ships, NS-04 will gain a `- PRs:` block per §3a.1 and the body Upstream prose will simplify; this block is preserved as the pre-amendment baseline for the matcher's behavior reasoning):

```markdown
### NS-04: Plan-001 T5.4 cwd-translator + Plan-024 T-024-2-1 contracts pair

- Status: `todo`
- Type: code (cross-plan PR pair, internally a 3-step sequence)
- Priority: `P1`
- Upstream: none (the 3-step sequence is internal: (a) `packages/contracts/src/pty-host.ts` interface-only PR for T-024-2-1 → (b) `packages/runtime-daemon/src/session/spawn-cwd-translator.ts` for T5.4 → (c) NodePtyHost impl T-024-2-2 lands as part of NS-05)
- References: [Plan-001](../../plans/001-shared-session-core.md):387-389, [Plan-024](../../plans/024-rust-pty-sidecar.md):75, 285, 301
- Summary: T5.4 wraps both `RustSidecarPtyHost` and `NodePtyHost` for OS-level cwd translation per I-024-5 to mitigate the Windows `ERROR_SHARING_VIOLATION` risk. F-024-2-04 binds T5.4 as a Precondition for **both** Plan-024 Phase 2 (NodePtyHost) **and** Phase 3 (RustSidecarPtyHost) — without it, Windows CI surfaces the sharing-violation regression. Clean sequence: ship the `PtyHost` contract interface alone, then T5.4 consumes it, then NS-05 consumes T5.4.
- Exit Criteria: `spawn-cwd-translator.ts` + Linux/macOS unit tests + Windows-CI integration tests (I6 / W2 / W3) green; `PtyHost` interface live in contracts.
```

**NS-12 — `completed`, `governance (doc-only)`, Status carries inline parenthetical resolution prose** (`cross-plan-dependencies.md`:452-460):

```markdown
### NS-12: Plan-001 Phase 5 split amendment + Phase 5 dep alignment

- Status: `completed` (resolved 2026-05-03 via this commit — Plan-001:357 rewritten to four-lane structure with per-task gating; downstream NS-02 + NS-22 unblocked)
- Type: governance (doc-only)
- Priority: `P1` (was critical-path for NS-02)
- Upstream: none
- References: [Plan-001](../../plans/001-shared-session-core.md):358-399 (post-amendment; pre-amendment was :357-397)
- Summary: Amended Plan-001 §Phase 5 Precondition (was :357 pre-amendment; now :358) to (a) canonicalize the four-lane Phase 5 split: **Lane A** (T5.1 / T5.5 / T5.6 unblocked once amendment lands) + **Lane B** (T5.4 paired with Plan-024 T-024-2-1, see NS-04) + **Lane C** (T5.2 after Plan-023-partial, see NS-06) + **Lane D** (T5.3 after Plan-023-partial + Plan-024 Phase 3, see NS-08); and (b) align Phase 5 Dependencies to include Plan-023 Tier 1 Partial substrate (per [BL-101](../../archive/backlog-archive.md#bl-101-c-3--plan-023-tier-1-partial-substrate-carve-out-mirrors-plan-007-partial--plan-008-bootstrap) (a) resolution 2026-04-30). Pre-amendment, Plan-001 §Phase 5 Precondition read as a monolithic gate ("Phase 5 cannot start until all three upstream Tier 1 substrates are merged") that conflicted with the per-task `Files:` lines at T5.1-T5.6; the amendment makes per-task gating canonical and resolves the conflict.
- Exit Criteria: Plan-001 §Phase 5 Precondition rewritten to enumerate the four-lane split with per-task gating; downstream NS-02 PRs cite Plan-001:358 directly. **Met.**
```

**NS-22 — `todo`, `cleanup (doc-only)`, free-form heading with NO `Plan-NNN` reference** (`cross-plan-dependencies.md`:502-510):

```markdown
### NS-22: Sibling-doc staleness sweep (cross-plan-deps audit propagation)

- Status: `todo`
- Type: cleanup (doc-only)
- Priority: `P2`
- Upstream: none (NS-12 resolved 2026-05-03 — the Plan-001 file co-ownership concern dissolves; NS-22's sweep targets at lines 12, 55, 121, 183, 297, 306, 308, 328, 337, 339 do not overlap with NS-12's edit ranges at lines 77-83 + 357-363)
- References: [Plan-001](../../plans/001-shared-session-core.md):12, 55, 122, 184, 298, 307, 309, 329, 338, 340 (line numbers post-NS-12 — `0001-initial.sql` cites); [Plan-022](../../plans/022-data-retention-and-gdpr.md):22, 51, 107, 159; [ADR-022](../../decisions/022-v1-toolchain-selection.md):14, 299; [Plan-001](../../plans/001-shared-session-core.md):369 `session.ts:388` cite (post-NS-12 line); [Plan-008](../../plans/008-control-plane-relay-and-session-join.md):28, 188 `session.ts:388` cite
- Summary: The cross-plan-deps audit (this PR) corrected two repo-truth drifts already present in §1 + §2 + §3 + §5: (a) migration filename `0001-initial.sql` → `0001-initial.ts` (live files are TypeScript per `packages/{runtime-daemon,control-plane}/src/migrations/`), and (b) `packages/contracts/src/session.ts:388` → `:408` (the `SessionSubscribe` comment block moved to line 408 after Plan-001 Phase 2 contract evolution). Both drifts also appear in sibling docs that this audit's scope did not modify. Sweep Plan-001 (10 occurrences of `.sql` + 1 of `:388`), Plan-022 (4 occurrences of `.sql`), ADR-022 (2 occurrences of `.sql`), and Plan-008 (2 occurrences of `:388`). Single PR, doc-only, ~30 min. Archive (`backlog-archive.md`) is frozen and excluded from sweep.
- Exit Criteria: All listed sibling-doc occurrences updated to current values; grep for `0001-initial\.sql` and `session\.ts:388` outside `docs/archive/` returns zero matches.
```

**NS-09 — `blocked`, `code + governance`, Upstream uses `+`-separator with mixed `NS-NN + BL-NNN` tokens** (`cross-plan-dependencies.md`:422-430):

```markdown
### NS-09: Plan-024 Phase 4 — CI cross-compile + signing

- Status: `blocked`
- Type: code + governance
- Priority: `P1`
- Upstream: NS-07 (Phase 3 working sidecar) + BL-108 (procurement evidence)
- References: [Plan-024](../../plans/024-rust-pty-sidecar.md):319-330, [BL-108](../../backlog.md#bl-108-plan-024-windows--macos-signing-procurement-evidence)
- Summary: 5-target `cargo-zigbuild` matrix (Windows MSVC, macOS x86_64/aarch64, Linux x86_64/aarch64) + Authenticode + Apple notarization. Phase 4 publishes signed pre-release binaries.
- Exit Criteria: All 5 targets build green; signed artifacts attached to release draft; Plan-024 §Decision Log records signing-track choice + date; BL-108 closes.
```

**NS-15..NS-21 — `blocked`, `audit (doc-only chain)`, range-form heading covering 7 atomic PRs, Upstream uses `→`-separator chain** (`cross-plan-dependencies.md`:492-500):

```markdown
### NS-15..NS-21: Tier 3-9 plan-readiness audits

- Status: `blocked`
- Type: audit (doc-only chain)
- Priority: `P2` (each tier is `P1` when its turn comes)
- Upstream: NS-14 → NS-15 (Tier 3) → NS-16 (Tier 4) → ... → NS-21 (Tier 9)
- References: [audit runbook](../../operations/plan-implementation-readiness-audit-runbook.md):85-87 ("Tiers: strictly serialized"), this document §5 (Tier 3-9 rows)
- Summary: Tiers 3-9 audits run one PR per tier (per CLAUDE.md "8 tier-PRs of audit work owed before broad Tier 2+ code execution can resume"). Each tier-K audit PR commits the tier's plan amendments + tags `plan-readiness-audit-tier-K-complete`. Tier 8 includes Plan-017 — the only `review`-status plan, which must promote `review → approved` at its tier audit.
- Exit Criteria: All 8 tier-PRs merged; all 27 plans cleared the audit; broad Tier 2+ code execution unblocked.
```

NS-14's Upstream sub-field also exhibits a sixth grammar form — free-form prose with a check-mark — included by reference rather than a sixth verbatim paste:

```
- Upstream: Tier 1 audit committed (✓ PR #15 / commit `05125dc`)
```

(`cross-plan-dependencies.md`:487; full NS-14 entry at lines 482-490.)

#### 1.1.2 Derived schema rules

**Heading grammar.** Headings match `^### NS-(\d+)(?:\.\.NS-(\d+))?([a-z])?: (.+)$`. The structural anchor is `NS-NN`, with three observed shape variants in the corpus:

1. **Plain numeric**: `### NS-01: Plan-024 Phase 1 — Rust crate scaffolding` (NS-01 through NS-12, NS-14, NS-22).
2. **Suffix-letter sub-numbering**: `### NS-13a: Spec-status promotion gate clarification` / `### NS-13b: Spec-027 \`draft\` → \`approved\` promotion` (current corpus has NS-13a + NS-13b).
3. **Range form (multi-PR chain)**: `### NS-15..NS-21: Tier 3-9 plan-readiness audits` — captures both endpoints (`15` and `21`); the housekeeper treats this as a multi-PR entry whose `PRs:` block (per §3a.1 amendment) enumerates one task per tier.

The title is free-form prose; many entries reference `Plan-NNN Phase N` substrings (NS-01, NS-12), but several (NS-04 — uses task-IDs `T5.4` + `T-024-2-1`; NS-11 / NS-22 — no plan reference at all; NS-15..NS-21 — references "Tier" rather than Plan/Phase) do not. **The script MUST NOT assume a `Plan-NNN Phase N — title` shape.** Plan/phase identity is resolved by the **orchestrator** via heading-only candidate-lookup (per §4.3.2 four-rule matching: Plan+Phase, Plan+task-id, Plan+Tier, range-form Tier-K), not by the script. The script verifies the orchestrator's resolved candidate against the diff per §5.1 step 3; file references are extracted per §3a.4.

**Sub-field grammar.** Every entry has the same seven sub-fields, each on its own line, each prefixed by `- ` (markdown list bullet):

- ``- Status: `<atomic>` `` — backticked atomic value, optionally followed by parenthetical resolution prose. Atomic values: `todo`, `in_progress`, `blocked`, `completed`. Regex: `^- Status: \x60(todo|in_progress|blocked|completed)\x60( \(.+\))?$`.
- `- Type: <free-form>` — NOT backticked. Observed corpus values (verified via `^- Type:` grep at HEAD): `code`, `code (recommended split into 3 atomic PRs)`, `code (single cohesive PR, 7 tasks)`, `code (cross-plan PR pair, internally a 3-step sequence)`, `code + governance`, `cleanup`, `cleanup (doc-only)`, `governance`, `governance (doc-only)`, `governance (load-bearing)`, `audit (doc-only)`, `audit (doc-only chain)`. Compound values (`code + governance`) and parenthetical qualifiers (`(doc-only)`, `(load-bearing)`) are normal — the script accepts free-form `Type:` strings and does NOT enumerate-or-reject.
- ``- Priority: `<atomic>` `` — backticked. Observed values: `P1`, `P2`. Optional parenthetical qualifier: ``- Priority: `P1` (was critical-path for NS-02)``, ``- Priority: `P2` (each tier is `P1` when its turn comes)``. Regex: `^- Priority: \x60(P\d)\x60( \(.+\))?$`.
- `- Upstream: <free-form-grammar>` — six observed shape variants in the corpus (verified via `^- Upstream:` grep at HEAD; line cites in `cross-plan-dependencies.md`):
  - `none` (NS-01, NS-11, NS-12, NS-13a, NS-22 — most common form for Tier 1 work)
  - `none` followed by a parenthetical justification (NS-01:347, NS-22:507) — the parenthetical is descriptive only; treat as `none` for cross-NS dependency analysis
  - **Comma-separated NS references** with optional parenthetical (NS-13b:477 — `NS-13a (gate must exist before Spec-027 can clear it)`)
  - **`+`-separated mixed `NS-NN + BL-NNN` tokens** (NS-05:387, NS-07:407, NS-08:417, NS-09:427, NS-10:437) — the housekeeper recognizes both `NS-NN` and `BL-NNN` token shapes; BL references mark backlog-gated work and do not participate in §6 ready-set re-derivation
  - **`→`-separated chain (range / serial dispatch)** (NS-15..NS-21:497 — `NS-14 → NS-15 (Tier 3) → NS-16 (Tier 4) → ... → NS-21 (Tier 9)`) — the housekeeper expands `→` chains into ordered upstreams; the `... →` ellipsis form is summary prose that the script reads literally and the subagent expands per the body Summary's tier-enumeration
  - **Free-form prose with check-mark** (NS-14:487 — `Tier 1 audit committed (✓ PR #15 / commit \`05125dc\`)`) — the housekeeper treats this as the equivalent of `none` (the upstream is satisfied; check-mark prose names the resolution evidence)

  The housekeeper parses `Upstream:` by tokenizing on `,` / `+` / `→` (treating each as a separator), extracting `NS-(\d+)([a-z])?` and `BL-(\d+)` tokens, and treating the literal `none` plus check-mark prose as "no blocking upstream." Anything else falls through to a `concerns` entry of `kind: upstream_grammar_unrecognized` for user disambiguation rather than silent guess.

- `- References: <markdown links + line cites>` — typically `[Plan-NNN](../../plans/NNN-...)` followed by `:NNN[-MMM]` line cite, comma-separated. May include literal repo-relative paths (e.g. `packages/runtime-daemon/src/bootstrap/secure-defaults-events.ts:24,35,59`).
- `- Summary: <one-paragraph prose>` — free-form. Inline file references (e.g. `packages/contracts/src/pty-host-protocol.ts`) appear here; they are NOT structured.
- `- Exit Criteria: <one-paragraph prose or sub-bullets>` — free-form prose. The housekeeper does NOT parse Exit Criteria for completion ticks.

**There is NO structured `Files:` sub-field.** No entry has a parseable `Files: <list>` line. File references appear inline in `References:` and `Summary:` prose. The housekeeper extracts file references from those two sub-fields using the heuristic in §3a.4 — it does NOT depend on a `Files:` field that doesn't exist.

**There is NO `Triggers-on:` or `depends-on:` field.** Plan/phase identity is encoded in the heading-text + body Summary prose; cross-NS dependencies are encoded in the `Upstream:` sub-field and reflected in mermaid `-->` edges.

**Status format extension (NS-12 precedent, line 454).** When a Status transitions to `completed`, the line MUST gain a parenthetical resolution annotation matching the NS-12 shape:

```
- Status: `completed` (resolved YYYY-MM-DD via PR #<N> — <one-line resolution context>)
```

The `<one-line resolution context>` is composed by the subagent stage from manifest context (PR#, merge date, what work landed, downstream NS-XX implications). The script stage emits a placeholder atomic flip; the subagent enriches with the prose. See §5.1 step 3a + §5.2 inputs.

**Mermaid graph (lines 282-336).** Each entry has a node line with class-attachment syntax `:::<class>`:

```mermaid
NS01[NS-01: Plan-024 Phase 1<br/>Rust crate scaffolding]:::ready
NS12[NS-12: Plan-001 Phase 5 split + dep alignment]:::completed
```

The classes are stable definitions at the bottom of the graph block (`cross-plan-dependencies.md`:332-335):

```mermaid
classDef ready fill:#9f9,stroke:#0a0,color:#000
classDef blocked fill:#fcc,stroke:#a00,color:#000
classDef completed fill:#ccc,stroke:#666,color:#000
classDef governance fill:#ffc,stroke:#aa0,color:#000
```

The status atomic set is `todo / in_progress / blocked / completed` (line 278). `:::ready` is a CSS class for visual grouping in the mermaid graph — an entry with `Status: \`todo\``whose`Upstream:`is satisfied is in the "ready set" (a derived predicate, not a stored field). The mermaid recolor maps`Status:` atomic → class:

| `Status:` atomic | Mermaid class | Mermaid → derived semantic |
| --- | --- | --- |
| `todo` (Upstream satisfied) | `:::ready` | green node |
| `todo` (Upstream blocked) | `:::blocked` | red node |
| `in_progress` | `:::ready` | green node (work in flight is treated visually as ready) |
| `blocked` | `:::blocked` | red node |
| `completed` | `:::completed` | grey node |

#### 1.1.3 Multi-PR entries (the schema gap that motivates §3a)

Three current entries cover multiple atomic PRs (verified from corpus):

- **NS-02** (line 355) — `- Type: code (recommended split into 3 atomic PRs)`
- **NS-04** (line 375) — `- Type: code (cross-plan PR pair, internally a 3-step sequence)`
- **NS-15..NS-21** (line 495) — `- Type: audit (doc-only chain)`; range-form heading (line 492) covers 7 atomic PRs; the literal phrase "1 PR per tier, sequential" appears in the mermaid label at line 302 (`NS15[NS-15..NS-21: Tiers 3-9 audits<br/>1 PR per tier, sequential]:::blocked`); the body Summary at line 499 phrases the same fact as "one PR per tier".

The current schema has no machine-parseable per-PR completion marker — multi-PR semantics are encoded in (a) prose qualifiers on the `Type:` line, (b) the range-form heading shape (NS-15..NS-21), and (c) elaboration in `Summary:` + mermaid label. This is the **schema gap** that motivates §3a (Schema amendment scope) below.

### 1.2 The gap

The plan-execution skill (v1 created 2026-04-26; v2 migration shipped 2026-05-03 in PR #28) **predates the §6 NS-XX convention**. Phase E of the skill (post-merge step) updates the plan's own `Progress Log` section but knows nothing about §6. Every plan-execution PR therefore leaves §6 maintenance as manual labor.

After every plan-execution PR merges into `develop`, the user has been doing this by hand:

1. Open `docs/architecture/cross-plan-dependencies.md` §6
2. Find the NS-XX entry whose heading + body identifies the merged PR's work
3. Flip status: `` - Status: `todo` `` → ``- Status: `completed` (resolved YYYY-MM-DD via PR #N — <prose>)`` (per the NS-12 precedent at line 454)
4. Recolor matching mermaid node by changing the class attachment: `:::ready` → `:::completed`
5. Re-derive "Recommended first wave" prose for the new ready set
6. Repair any inbound `:NNN` line cites in downstream docs that drifted from row insertion/deletion
7. Re-verify any set-quantifier claims affected (per `feedback_set_quantifier_reverification`)
8. Open a cleanup PR, run Codex review, merge

Steps 1–4 are mechanical. Steps 5–7 are semantic (require _understanding_ the new state). Step 8 is workflow overhead.

### 1.3 Why fix this now

- The gap recurs on every plan-execution PR (already burned cycles on PR #27, PR #29 cleanup loops).
- Manual housekeeping is precisely the failure mode `feedback_set_quantifier_reverification` and `feedback_canonicalization_sweep_completeness` were written to prevent — but a feedback memory is not a process gate. A process gate is.
- Q1 of the brainstorm locked: housekeeping must ship in the **same PR** as the plan-execution work. Separate cleanup PRs are themselves a maintenance burden and create a temporary "in-flight stale" state on `develop`.
- The next plan-execution PR (NS-01 / Plan-024 Phase 1) is queued; closing this gap before NS-04 dispatches means avoiding 5+ more manual cleanups across the Plan-024 chain.

## 2. Goal & non-goals

### 2.1 Goal

Phase E of the plan-execution skill auto-updates `docs/architecture/cross-plan-dependencies.md` §6 NS-XX entries + the plan's §Done Checklist after a plan-execution PR squash-merges, **in the same PR as the execution work**. Closes the "manual cleanup PR" loop entirely. Preserves set-quantifier reverification, line-cite sweep, and ready-set re-derivation discipline. Handles 1:1 NS↔PR entries AND multi-PR NS entries via the §3a schema amendment.

### 2.2 Non-goals (explicitly out of scope)

- Auto-resolving NEEDS_CONTEXT or BLOCKED — these always halt to the user (matches existing orchestrator hard rule per `references/failure-modes.md`).
- Tag/release automation — separate concern; release-please is already handling that.
- Spec promotion (`draft → review → approved`) — separate concern; the user has not asked for this and the trigger criteria are unclear.
- Triggering housekeeping outside plan-execution Phase E (e.g., from arbitrary `git push` events, doc-only PRs) — out of scope for V1; the script could be invoked manually if needed but the subagent is plan-execution-skill-internal.
- Generic "doc consistency" sweeps unrelated to plan-execution merges — out of scope.
- Retroactive backfill of historical NS entries — only entries authored after the schema amendment ships use the new `PRs:` shape; already-`completed` entries (NS-12) stay as-is.
- Mutating the §6 schema beyond the §3a amendment (no new `Files:` sub-field, no new `Open Questions` subsection, no `Change Log` table) — those would be separate corpus-mutation proposals with their own ADR-shaped reasoning.

## 3. Decision log (Q1–Q5 from brainstorm + Q6–Q7 hardening)

| Q | Decision | Reasoning |
| --- | --- | --- |
| Q1: separate cleanup PR or same PR? | **Same PR** (Option A, with manifest enhancement) | Atomic state flip; no temporary stale-on-`develop` window; one squash-commit per ship. |
| Q2: housekeeping scope | **§6 status flip + mermaid recolor + ready-set re-derivation + plan §Done Checklist tick** (Option C) | Covers everything currently being done by hand; excludes spec promotion / tag release (out of scope per §2.2). |
| Q3: implementation shape | **Hybrid script + subagent** (Option C) | Script handles deterministic regex-style edits (cheap, testable). Subagent handles re-derivation requiring semantic understanding. Avoids LLM cost on mechanical work; avoids brittleness on semantic work. |
| Q4: dispatch parameter sourcing | **[REVISED 2026-05-03 — see §4.1]** Orchestrator resolves NS-XX candidate via §6 lookup, then passes `--candidate-ns` to script (per §4.1 architectural decision "matcher as verification, not derivation") | Orchestrator already knows `<plan>` `<phase>` `<PR#>` from Phase A; uses heading-only §6 lookup (per §4.3.2) to resolve to `--candidate-ns NS-XX` (1 match), `--auto-create` (0 matches), or halt NEEDS_CONTEXT (2+ matches). Script verifies the candidate vs diff (Type-signature + file-overlap + plan-identity per §5.1 step 3) — no prose-derivation in script. The original Q4 decision (heading + body matching inside the script) was superseded after the third-pass review surfaced the matcher-narrowness failure-mode loop; §4.3 + §5.1 + §5.5 verification table replace it. |
| Q5: no-NS-XX-match behavior | **Auto-create with subagent intelligence** (Option E) | Skipping leaves dashboard stale → next plan-execution session may re-investigate "what's next" against an incomplete §6. Subagent has the context (cross-plan dep map + plan file + diff signature) to derive correct `Type:` + `Upstream:` for a new NS entry. AUTO-CREATE contract specified in §5.4. |
| **Q6: multi-PR NS semantics** | **Schema amendment as prerequisite — add structured `PRs:` sub-field to multi-PR entries** | Three current entries (NS-02, NS-04, NS-15..21) violate naive 1:1 NS↔PR. Without per-task ticks, the housekeeper would either flip multi-PR entries to `completed` after the first sub-PR (wrong) or skip them entirely (incomplete coverage). Per-task ticks make completion deterministic. Full scope in §3a. |
| **Q7: housekeeper failure on malformed NS** | **Surface as BLOCKED with actionable hint; do not silently fix** | Housekeeper enforces the schema contract. A `Type: code` entry whose body lacks the expected sub-fields (or a multi-PR entry without a `PRs:` block when one is required) becomes a hard halt — same shape as a reviewer ACTIONABLE finding. The subagent surfaces the schema violation in `concerns` and returns `RESULT: BLOCKED` (the canonical "subagent cannot proceed" exit-state per `references/failure-modes.md`). Forces corpus discipline forward; future authors cannot degrade the schema without the housekeeper noticing. |

Layout fix (post-Q5): all `*.md` files describing contracts move into `references/`; `scripts/` holds only executable `.mjs`. This requires moving the existing `scripts/preflight-contract.md` → `references/preflight-contract.md` and updating five inline path references (see §9.3).

## 3a. Schema amendment scope (Q6 + H1–H4)

The housekeeper's quality ceiling is set by the §6 schema it parses. Multi-PR NS entries currently rely on prose ("split into 3 atomic PRs") that's machine-unfriendly. The amendment converts that to structured ticks the housekeeper can deterministically read and update.

### 3a.1 New `PRs:` sub-field grammar

Multi-PR entries gain an **eighth, optional** sub-field, `PRs:`. **Single-PR entries do not get one** (their completion is unambiguous from the entry-level `Status:` field). The grammar matches the existing markdown-list convention of the other seven sub-fields:

```markdown
### NS-02: Plan-001 Phase 5 Lane A — sessionClient + pg.Pool + I7 (T5.1, T5.5, T5.6)

- Status: `in_progress` (last shipped: PR #34, 2026-05-04)
- Type: code (recommended split into 3 atomic PRs)
- Priority: `P1`
- Upstream: none (NS-12 resolved 2026-05-03 — Plan-001 §Phase 5 Precondition four-lane split is at HEAD; Lane A is now actionable directly against the per-task `Files:` rows)
- References: [Plan-001](../../plans/001-shared-session-core.md):358-399, integration tests I1-I4 at Plan-001:200-203
- Summary: ...
- Exit Criteria: All `PRs:` ticks checked.
- PRs:
  - [x] T5.1 — sessionClient + I1-I4 integration tests (PR #34, merged 2026-05-04)
  - [ ] T5.5 — pg.Pool-backed Querier composition
  - [ ] T5.6 — strengthen createSession lock-ordering test
```

Note that this example preserves all the existing NS-02 sub-field shapes verbatim (bullets + backticks + free-form `Type:` + `Upstream:` justification prose) and ADDS the `PRs:` block as a new sub-field at the end.

**Grammar rules (machine-enforced by the housekeeper script):**

- The `PRs:` sub-field is itself a markdown list bullet (`- PRs:`) followed by a nested markdown task list. Each item is `  - [ ] <task-id> — <description>` or `  - [x] <task-id> — <description> (PR #<N>, merged YYYY-MM-DD)`.
- `<task-id>` matches the corresponding `T-NNN-P-K` task ID from the audit-derived `#### Tasks` block in the plan (e.g., `T5.1`, `T-024-2-1`).
- A checked tick MUST include a parenthetical `(PR #<N>, merged YYYY-MM-DD)` annotation. The housekeeper writes this when it ticks a box; manual entries must follow the same shape.
- Task IDs must be unique within the `PRs:` block.
- The amendment migrates NS-02, NS-04, and NS-15..NS-21 to this grammar. Future multi-PR entries are authored with `PRs:` from inception.

### 3a.2 Completion-rule matrix

The script computes the entry's `Status:` from the `PRs:` block deterministically. Status emits use the canonical backticked-atomic-plus-prose format (per NS-12 precedent at line 454):

| `PRs:` block state | Upstream blocked-on cite present? | Computed `Status:` line emitted by script |
| --- | --- | --- |
| Absent (single-PR entry) | n/a (not affected by housekeeper at this layer) | ``- Status: `completed` (resolved YYYY-MM-DD via PR #<N> — <subagent prose>)`` |
| All ticks unchecked | no | `` - Status: `todo` `` |
| All ticks unchecked | yes | `` - Status: `blocked` `` |
| ≥1 checked, ≥1 unchecked | no | ``- Status: `in_progress` (last shipped: PR #<N>, YYYY-MM-DD)`` |
| ≥1 checked, ≥1 unchecked | yes | ``- Status: `blocked` (overrides — see Upstream: blocked even after partial PRs landed)`` |
| All ticks checked | n/a | ``- Status: `completed` (resolved YYYY-MM-DD via PR #<N> — last sub-task; <subagent prose>)`` |

The matrix is exhaustive and total. The script never needs to interpret prose to choose a `Status:` atomic value or framing. The completion rule is exercised by Layer 1 fixture tests (§8.1) — every cell of the matrix gets a fixture.

**Script vs subagent split for the prose annotation.** The script emits the atomic + structural prose (date, PR#, last-shipped reference). The `<subagent prose>` slot is filled in by the subagent stage, which has the context (manifest + diff + cross-plan implications) to compose a one-line resolution narrative matching NS-12's tone. The script writes a placeholder string `<TODO subagent prose>` that the subagent replaces; manifest-stage validation requires the placeholder to be absent before commit.

### 3a.3 Schema-amendment authoring as in-scope deliverable (NS-23)

The amendment ships as the **first** plan-execution-housekeeper-related work item, **before** the housekeeper itself. Concretely, the housekeeper design adds a new NS to §6:

```markdown
### NS-23: §6 schema amendment for multi-PR housekeeping

- Status: `todo`
- Type: governance (doc-only)
- Priority: `P1`
- Upstream: none
- References: [housekeeper design](../../superpowers/specs/2026-05-03-plan-execution-housekeeper-design.md) §3a
- Summary: Add structured `PRs:` sub-field to NS-02, NS-04, NS-15..NS-21 per the housekeeper design's §3a.1 grammar. Single-PR entries (NS-01, NS-03, NS-05..NS-10, NS-11, NS-13a, NS-13b, NS-14, NS-22) are unchanged. The amendment is the first dogfood for the housekeeper itself: NS-23's Status flips to `completed` MANUALLY when this PR merges (the housekeeper does not exist yet to auto-flip it). The next plan-execution PR after the housekeeper ships (PR 4 in §10.1) is the housekeeper's first auto-run.
- Exit Criteria: §6 entries NS-02, NS-04, NS-15..NS-21 carry `PRs:` blocks per §3a.1 grammar; `- Status: \`completed\` (resolved YYYY-MM-DD via this commit — schema amendment landed; housekeeper design §3a in-scope)` recorded inline on this entry.
```

**No fabricated subsections.** Earlier drafts referenced a `cross-plan-dependencies.md` Section 7 "Open Questions" subsection and a "Change Log" row — neither exists in the live document (its §7 is "Maintenance"; its only sub-section is "Forward-Declared Table Migration Ownership" at line 524). The amendment records its own resolution **inline** in NS-23's `- Status:` line, matching the NS-12 precedent. No new subsections are added.

Authoring NS-23 is part of this housekeeper PR series, not a separate prerequisite the user has to schedule. NS-23 ships **manually** (the housekeeper does not exist yet to auto-flip it). Once the housekeeper ships, the **next** plan-execution PR validates amendment + housekeeper together (see §10.2 bootstrap).

### 3a.4 File-reference extraction heuristic

Several semantic stages (set-quantifier reverification, line-cite sweep, ready-set re-derivation) need to know which files an NS entry references. There is no structured `Files:` sub-field. The subagent extracts file references from the `References:` and `Summary:` sub-fields using this documented heuristic:

1. **From `References:`:** parse markdown links matching `\[([^\]]+)\]\((\.\./[^)]+\.md)\)(:\d+(-\d+)?)?` to extract relative doc paths and optional line cites. Also parse bare-path tokens matching `[a-zA-Z0-9_./\-]+\.(md|ts|js|mjs|sql|rs|toml|json|ya?ml)(:\d+(,\d+)*(-\d+)?)?` to catch repo-root-relative source-file cites (e.g. `packages/runtime-daemon/src/bootstrap/secure-defaults-events.ts:24,35,59` from NS-11).
2. **From `Summary:`:** apply the same bare-path regex AND the directory-path regex from step 2a below. 2a. **Directory-path extraction.** Apply a separate directory-path regex `[a-zA-Z0-9_./\-]+/` (alphanumeric + `_./\-` ending in `/`) to References + Summary. This catches directory references that have no extension (e.g., `packages/runtime-daemon/src/pty/` from NS-05/07 Summary, `apps/desktop/src/renderer/src/session-bootstrap/` from NS-06 Summary, `.github/workflows/` from a hypothetical NS Summary). Directory paths are tagged separately from file paths in the extracted-references set; the file-overlap check (§5.1 step 3) treats them as **prefix-matchers** (any diff-touched file under the directory counts as overlap), where file paths require **exact match**.
3. **Brace-expansion handling.** The corpus uses bash-style brace expansion in path literals — NS-01 Summary (`cross-plan-dependencies.md`:349) contains `packages/sidecar-rust-pty/{Cargo.toml,Cargo.lock,src/{main,framing,protocol,pty_session}.rs,tests/{framing_roundtrip,protocol_roundtrip,spawn_smoke}.rs}` (a single token expanding to 9 paths). When the bare-path regex (or directory regex) matches a token containing `{...,...}`, the subagent expands it via the bash brace-expansion algorithm (recursive comma-split inside outermost braces, Cartesian-product against the surrounding literal) and treats each expanded path as a separate reference. Brace-expansion failures (unbalanced braces, empty alternatives) are surfaced in `concerns` with `kind: brace_expansion_malformed` rather than silently producing wrong paths.
4. **Filesystem resolution filter.** Filter false positives by requiring the path to resolve to a real filesystem entry when checked against the working-copy filesystem (subagent has `Read` + `Glob`). **File paths must resolve to an existing file**; **directory paths must resolve to an existing directory** (trailing `/` is normalized away during the resolve check). Brace-expanded paths are resolved individually. Paths the implementer is creating in this PR exist in the working copy at verify-time because the housekeeper runs on the PR branch with all implementation commits applied (per §6 data flow).
5. **Deduplicate** across both sources; preserve order of first appearance for stable output. File and directory references are deduped within their respective sets.

   **Scoping note: only `References:` and `Summary:` are scanned.** `Upstream:`, `Type:`, `Status:`, `Priority:`, and `Exit Criteria:` sub-fields are NOT extraction sources, even when they happen to contain source-path tokens. Corpus precedent: NS-04's `Upstream:` field at `cross-plan-dependencies.md`:377 names `packages/contracts/src/pty-host.ts` + `packages/runtime-daemon/src/session/spawn-cwd-translator.ts` inline — these are deliberately discarded by the heuristic. Authors who want source paths surfaced for file-overlap MUST place them in `References:` or `Summary:`.

6. **Subagent surfaces unresolvable paths in `concerns`.** If a path matches the regex but doesn't resolve (post-expansion), that's either a typo or a stale cite — both worth a `concerns` entry with `kind: unresolvable_file_reference` (the kind label uses `file_reference` for both files and directories — the distinction is recorded in the entry's `path_kind` field).

This heuristic is documented in `references/post-merge-housekeeper-contract.md` (per §9.1 new-files list) so that future authors can audit it. The heuristic does NOT propose adding a structured `Files:` field to the NS schema — that would be a separate corpus-mutation proposal outside this spec's scope (§2.2 non-goals).

### 3a.5 Why a structured `PRs:` field beats a prose contract

Steel-manning the alternative ("just have the housekeeper read prose and infer multi-PR completion"): a prose-inferring housekeeper would have to parse "split into 3 atomic PRs" (NS-02), "PR pair, internally a 3-step sequence" (NS-04), and "1 PR per tier, sequential" (NS-15) — three different prose shapes for three different multi-PR semantics. Each shape has edge cases (what if NS-04's "PR pair" ships only the first half? what if NS-15 skips a tier?). Prose-inference is the very LLM-judgment surface the design tries to eliminate.

The structured `PRs:` field replaces three prose shapes with one grammar, eliminates LLM judgment for status transitions, and gives the housekeeper a hard contract to validate against.

## 4. Architecture

The housekeeper enhances **Phase E** of the plan-execution skill. Today Phase E is: `append Progress Log → squash-merge → pull develop`. The new shape inserts a **candidate-resolution step** + **two housekeeping stages** before the squash-merge:

```
Phase E (today):
  Append Progress Log ──► Squash-merge PR ──► Pull develop

Phase E (with housekeeper):
  Orchestrator scans §6 for candidate NS-XX(s)  (per §4.3 rules)
       │  (heading-only matching: Plan-NNN + Phase-N | T-task-id | Tier-K;
       │   0 candidates → dispatch with --auto-create;
       │   1 candidate    → dispatch with --candidate-ns NS-XX;
       │   >1 candidates  → halt NEEDS_CONTEXT for user disambiguation)
       ▼
  Run post-merge-housekeeper.mjs <PR#> <plan> <phase> [task-id] {--candidate-ns NS-XX | --auto-create}
       │  (with --candidate-ns: VERIFY candidate vs diff (Type-signature + file-overlap +
       │     plan-identity); on PASS apply mechanical edits — §6 status flip / PRs: tick +
       │     completion-matrix recompute, mermaid class-attachment swap, plan §Done Checklist tick;
       │   with --auto-create: reserve next free NS-NN + emit manifest stub; subagent does
       │     the new-entry composition)
       ▼
  Orchestrator validates manifest (script stage)
       │
       ▼
  Dispatch plan-execution-housekeeper subagent ──► extends manifest.json
       │  (semantic: ready-set prose re-derivation, line-cite sweep,
       │   set-quantifier reverification, NS-XX auto-create composition, schema-violation findings)
       ▼
  Orchestrator validates manifest (subagent stage)
       │
       ▼
  Append Progress Log (existing)
       │
       ▼
  Single git commit ("chore(repo): housekeeping for PR #N — NS-XX completion")
       │  (Progress Log + housekeeping edits in ONE commit — see §6.1 for ordering rationale)
       ▼
  Squash-merge PR ──► Pull develop
```

### 4.1 Architectural decisions

- **Matcher as verification, not derivation.** The script does NOT scan §6 to derive which NS-XX a PR maps to. The orchestrator does that lookup (§4.3) and passes the resolved candidate(s) as `--candidate-ns NS-XX` (or `--auto-create` for genuinely new work). The script's job is to **verify** the candidate is consistent with the diff (Type-signature + file-overlap + plan-identity) and apply mechanical edits — not to guess from prose. This deletes the prose-matching surface that pass-1/2/3 reviewers kept widening (the matcher's per-corpus-entry-shape failure mode is replaced by a small, total verification rule-set; see §5.1 + §5.5 verification table).
- **Hybrid script + subagent.** Script does mechanical edits, subagent does semantic edits. A monolithic script can't re-derive ready-set prose; a monolithic subagent is overkill for regex-style edits and would need shell access (drift risk for the no-`Bash`-on-non-implementer-roles invariant).
- **Single PR, single branch, single commit.** All housekeeping edits AND the Progress Log append land on the existing PR branch BEFORE the squash-merge, in **one commit**. The orchestrator commits ONCE after both stages succeed (single rollback point; squash-merge collapses to one commit on `develop` regardless). The Progress Log append moves from its current position (before squash-merge as its own commit) to after the housekeeper stages — see §6.1 for why.
- **Manifest as contract.** A single JSON file in `.agents/tmp/`, written by the script and extended by the subagent. Orchestrator validates between stages. No versioning (greenfield, single-invocation contract — versioning would be YAGNI).
- **Sequential dispatch.** Script first, then subagent. Parallel dispatch would introduce race conditions on the manifest and complicate validation; serial cost is negligible.

### 4.2 New conceptual role

Adds a **7th plan-execution subagent role**: `plan-execution-housekeeper`. The conceptual model stays clean:

| Role                                   | Axis                                |
| -------------------------------------- | ----------------------------------- |
| `plan-execution-plan-analyst`          | Decompose phase → DAG               |
| `plan-execution-contract-author`       | Produce contract artifacts (shape)  |
| `plan-execution-implementer`           | Implement behavior                  |
| `plan-execution-spec-reviewer`         | Review against spec                 |
| `plan-execution-code-quality-reviewer` | Review code quality                 |
| `plan-execution-code-reviewer`         | Review for correctness/regressions  |
| `plan-execution-housekeeper` ⬅ NEW     | Cross-doc state hygiene after merge |

SKILL.md prose ("Six subagent roles") at line 29 must be updated to "Seven subagent roles" with the new role appended. SKILL.md `requires_files:` block does NOT need to add the housekeeper agent definition (subagent definitions auto-load on dispatch). See §9.3 for the full edit list.

### 4.3 Orchestrator candidate-lookup logic

Phase E's first new step is run by the **orchestrator** (the plan-execution skill itself, not a subagent and not the script). The orchestrator already knows which Plan + Phase + optional task-id the just-merged PR implements (it's the work it just dispatched and watched complete). It uses that metadata to scan §6 of `cross-plan-dependencies.md` for candidate NS-XX(s), then dispatches the housekeeper script with the resolved candidate(s) — converting "find the NS-XX from prose" (the matcher problem the script no longer owns) into "verify a known candidate is consistent" (the script's actual job, §5.1).

#### 4.3.1 Inputs

The orchestrator has these PR-metadata fields available at Phase E entry:

| Field | Source | Required? |
| --- | --- | --- |
| `<plan-NNN>` | The plan dispatched (e.g., `024` from `docs/plans/024-...`) | Yes for code/governance dispatches; absent for cross-plan emergent work |
| `<phase-N>` | The plan Phase header just completed (e.g., `1` from `### Phase 1 — ...`) | Phase is the dispatch granularity for non-multi-PR entries; for multi-PR Lane entries (NS-02, NS-04, NS-15..NS-21) the dispatch granularity is `<task-id>` and `<phase-N>` MAY be passed alongside `<task-id>` for use by the §4.3.2 matching rules. When both are passed, §4.3.2 rule 2 (Plan + task-id) takes precedence over rule 1 (Plan + Phase) per the precedence clause below |
| `<task-id>` | The task ID just completed (e.g., `T5.4`, `T-024-2-1`) | Yes when individual tasks dispatch (multi-PR phases like Plan-001 Lane A) |
| `<pr-tag>` | Conventional-commit footer or PR label (e.g., `plan-readiness-audit-tier-K-complete`) | Yes for audit dispatches (NS-14, NS-15..21); optional otherwise |
| `<tier-K>` | Derived from `<pr-tag>` for audits, OR from plan §header for non-Phase-shaped plans (Plan-023-partial uses Tier-N nomenclature) | When applicable |

#### 4.3.2 Heading-only matching

The lookup scans **only `### NS-...` heading titles**, NOT body Summary / References. Heading-only is deliberately conservative — body-prose matching reintroduces the brittle parsing surface the v3 reviewer surfaced (e.g., NS-14's Summary contains `Plan-002 Phase 1-6` describing the audit's parallel subagents, which would create a false-positive match against any future Plan-002 Phase 1 implementation PR). Heading text is authored intentionally to identify the work; body prose drifts.

For each `### NS-...` heading in §6, extract candidate identity tokens:

- `Plan-NNN` substring (case-insensitive, includes `-partial` suffix variants)
- `Phase N` substring (where N is a digit or `[A-Z]` letter)
- `T<N>` or `T-NNN-N-N` task-id substring
- `Tier K` substring (where K is a digit)
- `NS-NN..NS-NN` range-form (range covers Tiers K1..K2 — see NS-15..NS-21)

Match an NS-XX heading against the orchestrator's PR-metadata tuple `(plan, phase|task|tier)`:

1. **Plan-NNN + Phase-N exact match**: heading contains `Plan-<plan-NNN>` AND `Phase <phase-N>` (e.g., NS-01 matches `(024, 1)`; NS-02 matches `(001, 5)`).
2. **Plan-NNN + T-task-id exact match**: heading contains `Plan-<plan-NNN>` AND `T<task-id>` (e.g., NS-04 matches both `(001, T5.4)` and `(024, T-024-2-1)`; NS-06 matches `(001, T5.2)`).
3. **Plan-NNN + Tier-K exact match**: heading contains `Plan-<plan-NNN>` AND `Tier <tier-K>` (e.g., NS-03 matches `(023-partial, Tier 1)`; NS-14 matches `(002, Tier 2)`).
4. **Tier-K range-form match**: heading is range-form `### NS-NN..NS-NN: ... Tier K1-K2 ...` AND `<tier-K>` falls within `[K1, K2]` (e.g., NS-15..NS-21 matches `(_, Tier 3)` through `(_, Tier 9)`).

**Rule precedence when multiple rules fire on the same NS heading.** If the orchestrator passes both `<phase-N>` and `<task-id>` (legitimate for multi-PR Lane entries — e.g., NS-02 dispatch as `(Plan-001, Phase 5, T5.1)`), rule 1 (Plan + Phase) AND rule 2 (Plan + task-id) might both fire on the same heading. **Rule 2 wins**: the more specific identity (Plan + task-id) is preferred over the broader (Plan + Phase). This prevents a natural `(Plan-001, Phase 5, T5.4)` lookup from returning 2 candidates (NS-02 via rule 1 + NS-04 via rule 2) — instead it returns 1 (NS-04 via rule 2). When task-id is passed, the orchestrator's intent is task-granular dispatch; rule 1 is treated as a coarser fallback only when task-id is absent. Rules 3 and 4 (Tier-based) are independent of rules 1/2 — they apply to a different heading-token kind.

#### 4.3.3 Dispatch decision tree

After scanning all 17 (today) heading entries, the orchestrator counts matches:

| Match count | Orchestrator action | Script invocation (per §5.1 invocation header) |
| --- | --- | --- |
| 0 candidates | Dispatch script with `--auto-create` flag (genuinely new work; see §5.4) | `node post-merge-housekeeper.mjs <PR#> [--plan NNN] [--phase N] [--task TASK-ID] [--tier K] --auto-create` |
| 1 candidate (`NS-XX`) | Dispatch script with `--candidate-ns NS-XX` | `node post-merge-housekeeper.mjs <PR#> [--plan NNN] [--phase N] [--task TASK-ID] [--tier K] --candidate-ns NS-XX` |
| 2+ candidates | Halt Phase E with `NEEDS_CONTEXT` — surface candidate list with brief titles for user disambiguation; user resumes with explicit `--candidate-ns NS-XX[,NS-YY]` | (deferred until user resolves) |

The 2+ case is rare in the current corpus (verification table §5.5 shows zero auto-collisions across 17 entries) but is the safe fallback: never auto-pick when the corpus is genuinely ambiguous.

For genuine multi-candidate dispatches (e.g., a cross-plan PR pair NS-04 where the orchestrator legitimately wants the housekeeper to verify+update both plan citations), the user passes the comma-list directly (`--candidate-ns NS-04`). The script processes each independently and emits a multi-entry manifest.

#### 4.3.4 Out-of-scope NS shapes (manual housekeeping only)

Some NS shapes inherently do not map to a plan-execution-skill dispatch, even with the §6 amendment. These are auto-housekept ONLY when the user explicitly passes `--candidate-ns NS-XX`; the orchestrator's automatic lookup never auto-finds them:

| NS-XX | Heading | Why out-of-scope for auto-dispatch |
| --- | --- | --- |
| NS-13a | `Spec-status promotion gate clarification` | Pure governance amendment, no Plan-NNN tie. Spec-promotion PRs aren't run through plan-execution skill. |
| NS-13b | `Spec-027 \`draft\` → \`approved\` promotion` | Spec-promotion governance, References cite Plan-007 but the work is the spec-status flip not a Plan-007 Phase. |
| NS-22 | `Sibling-doc staleness sweep (cross-plan-deps audit propagation)` | Emergent multi-plan cleanup. References cite four plans + an ADR; no single Plan-NNN-Phase-N dispatch maps to it. |
| NS-11 (partial) | `Plan-007-partial completion cleanup` | Heading has `Plan-007-partial` but no Phase / Task / Tier — the cleanup is the act of declaring `Plan-007-partial` complete. The orchestrator's lookup will not surface this from a code-PR's metadata; user must pass `--candidate-ns NS-11` if running the housekeeper as part of a Plan-007-partial completion PR. |

This is **correct scope**, not a coverage gap. The third-pass reviewer's framing presupposed the housekeeper _should_ match all 17 entries; in fact 4 of the 17 are emergent / governance / cleanup shapes that don't fit a deterministic dispatch model. Forcing them into the auto-lookup would re-introduce the prose-parsing brittleness the §4.1 architectural decision deletes.

#### 4.3.5 Where this logic lives

The orchestrator-side lookup is implemented in **prose** in two places (it is not a script — the orchestrator is the plan-execution-skill LLM, which reads the `cross-plan-dependencies.md` §6 directly with `Read` and applies the matching rules above):

- `.claude/skills/plan-execution/SKILL.md` Phase E section — the procedural prose ("Before dispatching the housekeeper, scan §6 for candidate NS-XX...").
- `.claude/skills/plan-execution/references/state-recovery.md` — appendix prose documenting the lookup rules + dispatch decision tree for crash-resume scenarios (a Phase E that crashed mid-flow needs to re-run the lookup with the same metadata).

PR 4 of §10.1 ships both edits. The lookup prose mirrors §4.3.2 + §4.3.3 verbatim (single source of truth — this spec is normative for the runtime prose).

## 5. Components

### 5.1 `scripts/post-merge-housekeeper.mjs` — the mechanical stage

```
Invocation:  node post-merge-housekeeper.mjs <PR#>
                   [--plan <plan-NNN>] [--phase <phase-N>] [--task <task-id>]
                   [--tier <tier-K>] [--pr-tag <tag>]
                   {--candidate-ns NS-XX[,NS-YY...] | --auto-create}

   All metadata flags are optional and mirror §4.3.1's optionality model: the
   orchestrator passes whichever of `--plan` / `--phase` / `--task` / `--tier` /
   `--pr-tag` are populated for the dispatched work. At-least-one-of
   {--plan, --task, --tier} MUST be passed (the verification rules in step 3 need
   at least one identity token to anchor against the candidate heading; pure
   pr-tag dispatches with no plan/task/tier are not a current shape). NS-22-style
   manual housekeeping passes only `--candidate-ns NS-22` plus `<PR#>` (the
   plan-identity check is SKIPped per the cleanup-Type carve-out in step 3).

Writes:      .agents/tmp/housekeeper-manifest-PR<#>.json
Exit codes:  0  success
                   --candidate-ns mode: candidate verified + mechanical edits applied
                   --auto-create  mode: next free NS-NN reserved + manifest stub written
                                        (subagent composes the new entry's body in stage 2)
             1  --candidate-ns NS-XX not found in §6 (orchestrator misdispatch — halt)
             2  candidate verification failed (Type-signature / file-overlap / plan-identity
                   mismatch — halt BLOCKED via subagent surfacing of `verification_failures`)
             3  plan §Done Checklist not found / already fully ticked
             4  candidate is multi-PR shape but `--task <task-id>` arg missing (--candidate-ns mode only)
             5  schema violation: candidate has malformed `PRs:` block / missing required
                   sub-field (--candidate-ns) OR auto-create would duplicate an existing
                   heading title (--auto-create) — subagent dispatched to surface as BLOCKED
             ≥6 crash / IO error / arg-validation failure
```

Behavior (deterministic). The script branches on dispatch mode (`--candidate-ns` vs `--auto-create`); the orchestrator (per §4.3) decides which mode to invoke based on its prior §6 candidate-lookup. Mutually exclusive — passing both or neither → exit ≥6 (arg-validation crash).

**Common preamble (both modes):**

0. **Validate args.** `--candidate-ns` and `--auto-create` are mutually exclusive; exactly one MUST be passed. `--candidate-ns` value must match `NS-(\d+)([a-z])?(?:\.\.NS-(\d+))?` (single token or comma-list of tokens). At-least-one of `--plan` / `--task` / `--tier` MUST be passed (verification step 3 needs at least one identity token). Each metadata flag's value is validated for shape: `--plan` matches `\d{3}(-partial)?`, `--phase` matches `\d+|[A-Z]`, `--task` matches `T\d+(\.\d+)?|T-\d{3}-\d+-\d+`, `--tier` matches `\d+`. Any malformation → exit ≥6. Pure `<PR#>` + `--candidate-ns NS-XX` (no plan/task/tier) is permitted ONLY when the matched candidate's Type ∈ {cleanup, cleanup (doc-only), governance, governance (doc-only), governance (load-bearing)} — the carve-outs in step 3 collectively SKIP all three checks for these Types, so identity tokens are not required. For all other Types, missing identity tokens → exit ≥6.

**`--candidate-ns` mode (the common case — orchestrator's lookup found exactly one or more named candidates):**

1. **Locate the candidate NS entries.** Open `docs/architecture/cross-plan-dependencies.md`. Walk §6 headings via the regex `^### NS-(\d+)(?:\.\.NS-(\d+))?([a-z])?: (.+)$` (per §1.1.2 heading grammar — handles plain numeric, suffix-letter, and range-form variants). For each `--candidate-ns` token, find the heading whose captured `NS-(NN)([a-z])?(?:..NS-(NN))?` form exactly matches the token. Any token with no matching heading → exit 1 (orchestrator misdispatch — the candidate the orchestrator named does not exist; halt before any edit). For comma-list values, each candidate is processed independently; the script aborts on first failure rather than partial-applying.

2. **Schema-validate each candidate.** Before any edit, validate the matched NS entry has the seven required sub-fields (`- Status:`, `- Type:`, `- Priority:`, `- Upstream:`, `- References:`, `- Summary:`, `- Exit Criteria:`) each on its own bullet line. The `- Status:` and `- Priority:` lines must match their backticked regex (per §1.1.2). The `- Type:` line accepts free-form (no enum check). If the entry is multi-PR-shaped (per `- PRs:` sub-field present OR a `Type:` qualifier matching `(split into|PR pair|sequential|chain)`), validate the `- PRs:` block grammar against §3a.1. Any violation → exit 5 with manifest's `schema_violations` populated; mechanical edits aborted (no partial state on disk).

3. **Verify candidate vs diff.** Run three orthogonal checks per candidate (`verifyCandidate(candidate, gitDiff, args)`). ANY check failure → exit 2 with `manifest.verification_failures` populated; mechanical edits aborted.
   - **Type-signature consistency.** Candidate's `- Type:` value must be consistent with the diff signature per the inverse of §5.4's classification rules:
     - `code` / `code (...)` → diff MUST touch `packages/` or `apps/` (any modification or addition counts; `.github/workflows/` and `packages/`-side build config like `Cargo.toml` also count as `code`-side per corpus precedent).
     - `audit (doc-only)` / `audit (doc-only chain)` → diff MUST be doc-only (NO `packages/` or `apps/` files touched).
     - `governance` / `governance (doc-only)` / `governance (load-bearing)` → diff MUST touch `docs/` AND no `packages|apps/` files (any `docs/` subdirectory counts: `decisions/`, `specs/`, `plans/`, `operations/`, `archive/`, `architecture/`, `domain/`, `backlog.md`).
     - `code + governance` → diff MUST touch BOTH `docs/` AND `packages|apps/` (the `governance` side is typically `docs/plans/<NNN>-...md` §Decision Log + `docs/backlog.md` / `docs/archive/backlog-archive.md` BL-NNN movement; corpus precedent NS-09:425 Phase 4 ships CI workflow + Cargo.toml signing config + Plan-024 §Decision Log + BL-108 archival).
     - `cleanup` / `cleanup (doc-only)` → permissive (no diff-shape constraint; cleanup may sweep arbitrary files). Surfaces a `concerns` entry of `kind: cleanup_diff_unverified` for user awareness but does NOT halt. Mismatch → halt with `kind: type_signature_mismatch` in `verification_failures` (ACTIONABLE: orchestrator misdispatched the wrong candidate for this PR's diff shape).
   - **File-overlap signal.** Extract candidate's file references via the §3a.4 heuristic (parses `References:` + `Summary:` sub-fields, includes brace-expansion AND directory-path extraction per §3a.4 step 2a). The extracted-references set has two kinds of entries: **file paths** (exact-match required) and **directory paths** (prefix-match: any diff-touched file whose path begins with the directory string counts as overlap). Compute intersection with the diff's touched-file set under both rules:
     - File-path entry: counts as overlap iff some diff-touched file path equals it.
     - Directory-path entry (e.g., `packages/runtime-daemon/src/pty/`): counts as overlap iff some diff-touched file path starts with it (e.g., `packages/runtime-daemon/src/pty/node-pty-host.ts` overlaps with `packages/runtime-daemon/src/pty/`).

     **Required overlap depends on candidate Type — three-state outcome for `code` Types:**
     - `code` / `code (...)` / `code + governance`:
       - **Extracted set NON-EMPTY AND intersection NON-EMPTY** → PASS. Note: per §3a.4 step 1 the extractor pulls plan/spec/ADR markdown-link targets (`[Plan-NNN](../../plans/NNN-...md)`) as file paths. Combined with the corpus convention that every plan-execution PR touches its plan's Decision Log, this means `code + governance` and `code (...)` entries whose body cites a plan but names no source paths (NS-04/09/10 in the current §6) PASS via _doc-path overlap only_ — verification load shifts to Type-signature + plan-identity for these. This is a documented limit, not a bug; misdispatch within a single plan-cited Type-signature shape is rare-bug territory and the orchestrator's heading-grep (§4.3.2) is the load-bearing matcher. See §5.5 trace for per-entry discriminator.
       - **Extracted set NON-EMPTY AND intersection EMPTY** → halt with `kind: file_overlap_zero` in `verification_failures` (the candidate's References / Summary names files/directories the PR didn't touch — orchestrator probably misdispatched the wrong candidate).
       - **Extracted set EMPTY** → SOFT-WARN: surface a `concerns` entry of `kind: file_overlap_unverifiable_for_sparse_body` and continue (do NOT halt). Defensive future-proofing for entries lacking any extractable path _including_ plan-link `.md` references — i.e., References + Summary contain no markdown links to `.md` files AND no bare source-file tokens AND no directory tokens. **No current §6 entry trips this state** (verified empirically in §5.5 trace; every entry's References cites at least one `[...](../plans|specs|decisions/NNN-...md)` link which the §3a.4 step 1 regex extracts). The state exists for future entries that might be authored without any markdown link cite.
     - `audit (doc-only)` / `audit (doc-only chain)` → SKIP this check (audit work walks the whole audited plan via the runbook; specific file-overlap with NS References is not expected).
     - `cleanup` / `cleanup (doc-only)` / `governance` / `governance (doc-only)` / `governance (load-bearing)` → SKIP this check (cleanup + governance work may legitimately touch files not pre-named in References).

   - **Plan-identity sanity check.** **Carve-out for cleanup / governance Types**: if candidate `- Type:` ∈ {`cleanup`, `cleanup (doc-only)`, `governance`, `governance (doc-only)`, `governance (load-bearing)`}, this check is SKIPped (parallel to the Type-signature permissivity for `cleanup` and the file-overlap SKIP for these Types — these shapes are explicit-candidate manual dispatches per §4.3.4 and their headings legitimately do not carry Plan-NNN / task-id / Tier-K tokens). Surface a `concerns` entry of `kind: plan_identity_skipped_for_manual_dispatch` for user awareness but do NOT halt. For all other Types, candidate's heading title MUST contain at least one of:
     - The `--plan` arg if passed (substring `Plan-<plan-NNN>`, e.g., `Plan-024`).
     - The `--task` arg if passed (substring match, e.g., `T5.4` or `T-024-2-1`).
     - The `--tier` arg if passed, matched per **two** sub-rules (mirrors §4.3.2 rule 3 + rule 4):
       1. **Substring**: heading contains `Tier <tier-K>` literal (e.g., NS-14's heading `Tier 2 plan-readiness audit — Plan-002` matches `--tier 2`).
       2. **Range arithmetic**: heading is range-form `### NS-NN..NS-NN: ... Tier K1-K2 ...` AND `<tier-K>` ∈ `[K1, K2]` (e.g., NS-15..NS-21's heading `Tier 3-9 plan-readiness audits` matches `--tier 5` because 5 ∈ [3, 9]). Without this branch, six of seven Tier audits (K=4,5,6,7,8,9) would FAIL plan-identity even though §4.3.2 rule 4 correctly auto-dispatched them. This catches orchestrator misdispatch — passing `--candidate-ns NS-01` when the PR is actually for Plan-007. Mismatch → halt with `kind: plan_identity_missing` in `verification_failures`. **Note on `--phase`**: phase is NOT in the disjunct list. Plan-identity is OR-semantics ("MUST contain at least one of"); adding `--phase` to an OR list filters nothing when `--plan` is already passed and matches. Tightening to discriminate phase-N within plan would require AND-of-passed-tokens semantics — a structural rule change beyond this design's scope. The orchestrator's heading-grep matcher (§4.3.2) already discriminates phase via rule 1 (Plan + Phase exact match); plan-identity here is verification, not derivation.

   Verification is per-candidate; for comma-list `--candidate-ns NS-XX,NS-YY`, the script verifies each independently and reports first-failure with remaining candidates' verification states enumerated.

4. **Determine entry shape.**
   - **Single-PR entry** (no `- PRs:` line in body): proceed to step 5a.
   - **Multi-PR entry** (`- PRs:` sub-field present): require the `[task-id]` CLI arg; if missing, exit 4. Otherwise proceed to step 5b.

5a. **Single-PR status flip.** Replace the matched ``- Status: `todo` `` (or ``- Status: `in_progress` ``) line with ``- Status: `completed` (resolved <today> via PR #<N> — <TODO subagent prose>)``. `<today>` from system clock; `<N>` from CLI arg; `<TODO subagent prose>` is a literal placeholder the subagent stage replaces (manifest-stage validation rejects commits with the placeholder still present).

5b. **Multi-PR tick + completion-matrix recompute.** Find the matching task-id row in the `- PRs:` block; replace `  - [ ] <task-id> — <desc>` with `  - [x] <task-id> — <desc> (PR #<N>, merged <today>)`. Then walk the full `PRs:` block and recompute `- Status:` per the matrix in §3a.2. Detect `Upstream: <NS-XX>` cite where the upstream is itself ``- Status: `blocked` `` — apply blocked-override per matrix.

6. **Recolor matching mermaid node.** In §6's mermaid graph block (lines 282-336), find the node line `NS<NN>[<label>]:::<old-class>` and replace `:::ready` (or `:::blocked` / `:::completed`) per the §1.1.2 mermaid mapping table. `classDef` definitions (`classDef ready ...`) at the bottom of the graph are NOT touched.

7. **Tick plan §Done Checklist.** Open `docs/plans/NNN-*.md`, find the matching `### Phase N — ...` section, locate its "Done Checklist" sub-section, and tick **all** boxes (rationale: Q11.7 — Phase E only fires after a complete Phase merges, so partial ticks indicate a bug elsewhere, not a feature here).

8. **Emit manifest** describing what was done + what semantic work remains.

**`--auto-create` mode (orchestrator's lookup found zero candidates — genuinely new work):**

In this mode the script does NOT apply candidate-side mechanical edits (steps 5a/5b/6 are skipped — there is no existing NS to flip / tick / recolor). It DOES perform schema reservation + plan §Done Checklist tick + manifest stub emission. The subagent composes the new NS entry's body in stage 2 (per §5.4).

1'. **Reserve next free NS-NN.** Walk all `### NS-(\d+)` headings via the regex; find the highest captured integer (ignoring sub-numbering letters like `13a` / `13b` and range-form upper bounds — the canonical numbering authority is the integer prefix). Reserve `NN+1` as the new entry's number. Defensive check: verify `NN+1` is not already present anywhere in §6 (catches manual numbering races).

2'. **Duplicate-title guard.** Derive the would-be-allocated heading title from the merged PR's title (stripped of conventional-commit prefix) OR from `<plan-NNN> Phase <phase-N>`. Search existing `### NS-...` headings for any whose title is a substring-equivalent of the would-be heading (e.g., AUTO-CREATE for "Plan-024 Phase 1" when NS-01 already exists with that exact prose). On duplicate-title risk → exit 5 with `kind: auto_create_duplicate_title` in `schema_violations` (subagent surfaces NEEDS_CONTEXT for user disambiguation — this usually means the orchestrator's §6 lookup missed an existing candidate).

3'. **Tick plan §Done Checklist.** (Same as `--candidate-ns` step 7. The dispatched Phase still completes regardless of whether an NS existed pre-merge.)

4'. **Emit manifest stub** with `auto_create.reserved_ns_nn`, `auto_create.derived_title_seed`, and `mechanical_edits.plan_checklist_ticks` populated. `mechanical_edits.status_flip` / `mermaid_class_swap` are absent (the new node is added by the subagent, not the script). `semantic_work_pending` includes the auto-create-specific items: `auto_create_compose_entry`, `auto_create_compose_mermaid_node`, `auto_create_derive_upstream`.

**Design choices for testability:**

- Exports `runHousekeeper({ args, repoRoot })` — `repoRoot` parameter (not hardcoded `process.cwd()`) enables fixture isolation in tests.
- All file edits flow through a "planned edits" intermediate inspectable before writing — enables `--dry-run` mode for manual debugging.
- Exit code is returned, not thrown — clean test assertions.
- Pure parser functions (`parseNsHeading`, `parseSubFields`, `parsePRsBlock`, `computeStatusFromPRs`, `extractPlanFromEntry`) are individually exported for unit tests separate from full-pipeline fixture tests.

### 5.2 `.claude/agents/plan-execution-housekeeper.md` — the semantic stage

YAML frontmatter (mirrors `plan-execution-contract-author` shape, including its `color: blue`):

```yaml
---
name: plan-execution-housekeeper
color: blue
description: Internal subagent for the /plan-execution orchestrator only. Do not invoke
  directly — the orchestrator dispatches this subagent in Phase E after running
  post-merge-housekeeper.mjs to perform semantic state hygiene (ready-set re-derivation,
  line-cite sweep, set-quantifier reverification, NS-XX auto-create, schema-violation
  reporting, completion-prose composition) on the merged PR's cross-plan-dependencies.md
  §6 + downstream-doc context. The orchestrator passes the manifest path + script exit
  code via the prompt parameter; this subagent edits affected files and returns an
  extended manifest plus a RESULT: tag.
model: inherit
tools: ["Read", "Grep", "Glob", "Edit", "Write"]
---
```

Body sections (matching contract-author/implementer convention):

- **Inputs** — manifest path, script exit code, PR#, plan, phase, optional task-id
- **Mindset** — "Your axis is semantic state hygiene across the doc corpus. Mechanical edits are already done; your job is the work that needs to _understand_ the new state."
- **Hard rules** —
  - No `git` (mechanically enforced via `tools:` omission).
  - Do NOT re-run the script.
  - Edit only files declared in the manifest's `affected_files` list (extending the list is permitted when the line-cite sweep finds new affected files; the orchestrator validates the extension is justified).
  - Every `semantic_work_pending` item from the manifest either gets a `semantic_edits` entry OR a `concerns` entry explaining deferral.
  - Replace any `<TODO subagent prose>` placeholders the script left in `Status:` lines with composed one-line resolution prose matching the NS-12 precedent shape (see §1.1.2 Status format extension).
  - **Schema violations from script exit 5 are surfaced in `concerns` with `kind: schema_violation` + structured remediation hint, then return `RESULT: BLOCKED`. Never silently fix.** This is the canonical "subagent cannot proceed" exit-state per `references/failure-modes.md` § BLOCKED — the housekeeper's contract is enforce-the-schema-or-halt, identical in shape to a reviewer's ACTIONABLE finding.
  - **PRs that touch NS-referenced files but whose body does not annotate any NS-XX** are surfaced as `concerns` with `kind: unannotated_ns_referenced_files` and the entry returns `RESULT: DONE_WITH_CONCERNS` — the housekeeper does NOT silently no-op. The Reviewer/user decides whether to backfill the NS annotation in PR description or accept the omission.
- **Decision presentation** — for ambiguous re-derivations (e.g., "is this NS now ready or still blocked by NS-13b?"), present recommendation + alternative + tipping constraint
- **Exit states** — `DONE` / `DONE_WITH_CONCERNS` / `NEEDS_CONTEXT` / `BLOCKED` (the four canonical exit-states from `references/failure-modes.md`; no new states introduced)
- **Report format** — files edited, manifest path, suggested commit message

### 5.3 The manifest — the contract between stages

One JSON file, two write stages, no versioning:

```json
{
  "generated_at": "2026-05-03T14:32:11Z",
  "pr_number": 30,
  "plan": "024",
  "phase": "1",
  "task_id": null,
  "script_exit_code": 0,

  "// — written by script —": "",
  "matched_entry": {
    "ns_id": "NS-01",
    "heading": "### NS-01: Plan-024 Phase 1 — Rust crate scaffolding",
    "shape": "single-pr",
    "file": "docs/architecture/cross-plan-dependencies.md",
    "heading_line": 342
  },
  "mechanical_edits": {
    "status_flip": {
      "ns_id": "NS-01",
      "from_line": "- Status: `todo`",
      "to_line": "- Status: `completed` (resolved 2026-05-03 via PR #30 — <TODO subagent prose>)",
      "computed_via": "single-pr direct flip"
    },
    "prs_block_ticks": [],
    "mermaid_class_swap": {
      "ns_id": "NS-01",
      "from": ":::ready",
      "to": ":::completed",
      "node_line": 285
    },
    "plan_checklist_ticks": [
      { "file": "docs/plans/024-rust-pty-sidecar.md", "phase": "1", "items_ticked": 5 }
    ]
  },
  "schema_violations": [],
  "verification_failures": [],
  "affected_files": [
    "docs/architecture/cross-plan-dependencies.md",
    "docs/plans/024-rust-pty-sidecar.md"
  ],
  "semantic_work_pending": [
    "compose_status_completion_prose",
    "ready_set_re_derivation",
    "line_cite_sweep",
    "set_quantifier_reverification",
    "ns_auto_create_evaluation",
    "unannotated_referenced_files_check"
  ],
  "warnings": [],

  "// — written by subagent (null/empty until subagent fills) —": "",
  "subagent_completed_at": null,
  "semantic_edits": {},
  "concerns": [],
  "result": null
}
```

For multi-PR shape, `matched_entry.shape` is `"multi-pr"`, `mechanical_edits.status_flip.computed_via` is `"prs-matrix recompute"` with the matrix-row that fired, and `mechanical_edits.prs_block_ticks` carries the per-tick details.

Stage 1 (script) writes the file with subagent fields stubbed. Stage 2 (subagent) reads, fills in its fields (including replacing the `<TODO subagent prose>` placeholders in `Status:` lines via direct file edits, then echoing the composed prose into `semantic_edits.completion_prose`), writes back.

**Validation invariants (orchestrator):**

- After script: `mechanical_edits` populated per `script_exit_code` (exit 1 → `matched_entry` and `status_flip` may be absent; exit 3 → `plan_checklist_ticks` may be empty; exit 5 → `schema_violations` non-empty + edits aborted). `semantic_work_pending` non-empty. `result === null`.
- After subagent: `result !== null`. Every item in `semantic_work_pending` appears in EITHER `semantic_edits` OR `concerns`. Every entry in `schema_violations` appears in `concerns` with matching `kind: schema_violation`, AND `result === "BLOCKED"`. No `<TODO subagent prose>` placeholders remain in any file under `affected_files`. `affected_files` ⊇ files actually edited (subagent did not sprawl outside declared scope; extensions to `affected_files` are documented in `concerns` with `kind: affected_files_extension`).

If validation fails, orchestrator halts Phase E and surfaces the gap (script-stage failure) OR round-trips to the subagent (subagent-stage failure).

### 5.4 AUTO-CREATE mode dispatch contract (Q5)

When the orchestrator's §6 candidate-lookup (per §4.3) finds zero candidates, it dispatches the script with the `--auto-create` flag (no `--candidate-ns` value). The script's `--auto-create` branch (per §5.1 steps 1'–4') reserves the next free `NS-NN` integer + emits a manifest stub with `auto_create.reserved_ns_nn` populated; the subagent stage then composes the new NS entry's body and inserts it into §6.

This section specifies the contract the subagent follows when composing the new entry's body (the script does NOT compose the body — its job is reservation + duplicate-title guard + plan checklist tick).

**Out-of-scope shapes (orchestrator never auto-dispatches in `--auto-create` mode for these — they are manual housekeeping per §4.3.4):**

- **Multi-plan staleness sweeps** (NS-22 shape — diff touches multiple `docs/plans/` + an ADR but is emergent cleanup not tied to a single dispatch). The orchestrator's §4.3 lookup never auto-finds NS-22 (no Plan-NNN match); user runs the housekeeper manually with `--candidate-ns NS-22` for these cases.
- **Spec-promotion governance** (NS-13a / NS-13b shapes — Spec-status amendments without Plan-NNN tie).

These shapes are documented in §4.3.4 as out-of-scope for auto-dispatch. The Type-inference rules below therefore omit the "multi-plan staleness sweep" rule the third-pass reviewer (correctly) caught as self-defeating against NS-22's References (which include `ADR-022` at `docs/decisions/`, falsifying the rule's "no `docs/decisions|specs/`" predicate).

**Allocation rules (subagent stage):**

- **NS number**: pre-reserved by script per §5.1 step 1' (`auto_create.reserved_ns_nn`). Subagent uses the reserved value verbatim. As of 2026-05-03 the highest existing integer is `22`, so the next free is `23` — but NS-23 is reserved by §3a.3 for the schema amendment, so the housekeeper's first AUTO-CREATE allocates from `24+` (the script's reservation logic is aware of the §3a.3 reservation and skips it).
- **Initial `- Status:`**: `` `completed` (resolved YYYY-MM-DD via PR #<N> — auto-created by housekeeper; <TODO subagent prose>) `` (the work is shipping; the entry is born `completed` with the same backticked-atomic-plus-prose shape as a flip, per NS-12 precedent).
- **Heading**: `### NS-NN: <derived title>`. Title is seeded by the script per §5.1 step 2' (`auto_create.derived_title_seed` — derived from the merged PR's title with the conventional-commit prefix stripped, OR from `<plan-NNN> Phase <phase-N>` when the PR title is too generic). Subagent may refine the title for clarity (e.g., adding the work's noun-phrase axis) but must not introduce a substring-collision with an existing heading title (re-runs the script's duplicate-title guard before committing).
- **`- Type:` (inferred from diff signature):** the corpus distinguishes 12 distinct `Type:` values (per §1.1.2 enumeration). Diff signature alone cannot distinguish all of them; the rules below cover the cases a diff signature CAN reliably classify; residuals are surfaced as `concerns` for user-correction post-creation.
  - Diff touches only `docs/decisions/` or `docs/specs/` → `governance (doc-only)`.
  - Diff touches only `docs/operations/` audit-runbook files → `audit (doc-only)`.
  - Diff touches `packages/` or `apps/` source files (additions OR modifications) AND no `docs/decisions|specs/` → `code`. Surface a `concerns` entry of `kind: type_inference_uncertainty` with text: "If this PR is mechanical sweep / stale-comment-removal / cleanup of existing files (not new functionality), correct Type to `cleanup` post-creation. Diff signature cannot reliably distinguish `code` from `cleanup` for `packages/`-touching work — corpus precedent: NS-11 is `cleanup` because it only removes 3 stale `BLOCKED-ON-C9` comments." (NS-11:445 precedent.)
  - Diff touches BOTH `docs/decisions|specs/` AND `packages|apps/` → `code + governance` (no qualifier; corpus precedent: NS-09:425, NS-10:435).
  - Diff touches only `docs/plans/` (single plan, e.g. plan-status promotion) → `governance (doc-only)`.
  - **Otherwise** (mixed but not matching above shapes; e.g., diff touches `docs/plans/` of multiple plans without `packages/`) → halt `NEEDS_CONTEXT` with the diff signature surfaced for user disambiguation. **Do NOT default to `code`. Do NOT auto-classify NS-22-shape multi-plan sweeps** — those are out-of-scope per §4.3.4 (manual housekeeping only). Surfacing `NEEDS_CONTEXT` here is the correct behavior: the orchestrator's §4.3 lookup already returned zero candidates AND the diff doesn't fit a clean Type-signature, so user adjudication is the only safe path.

  **Corpus residuals not detectable from diff signature alone:**
  - `code (recommended split into 3 atomic PRs)` / `code (single cohesive PR, 7 tasks)` / `code (cross-plan PR pair, internally a 3-step sequence)` / `audit (doc-only chain)` — these multi-PR qualifiers depend on knowing the work's structure ahead of time, which AUTO-CREATE doesn't have. Auto-created entries default to the bare `code` / `audit (doc-only)` form; the user upgrades to a multi-PR qualifier + `PRs:` block (per §3a.1) when the work spans atomic PRs.
  - `governance (load-bearing)` (NS-13b:475) — "load-bearing" is a qualitative judgment about downstream impact that diff signature can't surface. Auto-created governance entries default to bare `governance (doc-only)`; user upgrades to `(load-bearing)` if applicable. (NS-13a / NS-13b shapes themselves are out-of-scope per §4.3.4 — they are not auto-created.)
  - `cleanup` / `cleanup (doc-only)` for genuinely-emergent multi-plan sweeps (NS-22 shape) — out-of-scope per §4.3.4; never auto-created. The user runs the housekeeper manually with `--candidate-ns NS-22` after authoring the entry by hand if a new emergent sweep arises.

- **`- Priority:`**: `` `P1` `` for code / audit / code+governance; `` `P2` `` for cleanup / governance-only. The subagent surfaces the choice in `semantic_edits.auto_create.priority_reasoning`.
- **`- Upstream:`**: subagent reads the plan + `cross-plan-dependencies.md` tier graph to derive correct upstream NS-XX cites. Halts NEEDS_CONTEXT if ambiguous (rather than guessing).
- **`- References:`** + **`- Summary:`** + **`- Exit Criteria:`**: subagent composes from the plan section + PR description.
- **Position in §6**: append at the end of §6 (after the highest existing NS-NN), maintaining numerical order. Re-deriving subsection grouping is out of scope (the existing §6 has no machine-detectable subsection structure beyond the mermaid graph's class groupings).
- **Mermaid graph**: add new node line `NS<NN>[NS-NN: <truncated label, ≤60 chars><br/>second-line-detail]:::completed` (immediately marked `:::completed` since the work just shipped); add edges from upstream nodes per derived `Upstream:` field.
- **`- PRs:` sub-field**: omitted by default (auto-create defaults to single-PR shape). If the orchestrator passed a `[task-id]` arg, the subagent infers multi-PR shape and constructs a `- PRs:` block with the one task ticked + remaining tasks unchecked, requiring NEEDS_CONTEXT halt for the user to confirm the remaining task list.

The manifest's `auto_create.reserved_ns_nn` is set by the script; subagent fills `semantic_edits.auto_create.{title, type, priority, upstream, references, summary, exit_criteria, mermaid_node_line, mermaid_edges}`. `affected_files` includes `docs/architecture/cross-plan-dependencies.md` (new heading + body + mermaid additions all live in this single file).

### 5.5 Verification table — every NS-XX traced through the new design

This table is the falsification evidence for §4.3 + §5.1. Every NS entry in `cross-plan-dependencies.md` §6 (verified at HEAD 2026-05-03; 17 entries via `^### NS-` grep) is traced through the orchestrator's candidate-lookup (§4.3) and the script's verification (§5.1 step 3). The expected outcome for each entry is recorded; future corpus additions MUST be added to this table before the housekeeper PR series can ship them.

**Normative target.** The table verifies against **the post-§3a.1-amendment state** (the design's normative target — what §6 looks like AFTER the schema amendment ships). Rows for **NS-02, NS-04, NS-15..NS-21** assume the `PRs:` block has been migrated per PR 1 of §10.1 (NS-23 in §3a.3). At HEAD on 2026-05-03 those entries do not yet carry `PRs:` blocks — the table's claimed multi-PR completion-matrix outcomes for those rows are reachable only after PR 1 lands. The §10.2 bootstrap exercises the full pipeline against the post-amendment state.

**Summary by outcome (every cell empirically traced against on-disk References + Summary at HEAD 2026-05-03):**

- **13 entries auto-housekept** (orchestrator's §4.3 lookup auto-finds them; file-overlap discriminator recorded per row):
  - **PASS via file-path** (extracted set has explicit source-file paths the diff touches): NS-01, NS-02 (T5.1 lane), NS-08
  - **PASS via dir-prefix** (extracted set has directory tokens; diff files match by `startsWith` per ACTIONABLE-4): NS-03, NS-05, NS-06, NS-07
  - **PASS via doc-path overlap only** (Summary names no source paths; only the plan markdown link `[Plan-NNN](../../plans/NNN-...md)` from References extracts; diff touches that plan's Decision Log on the governance side; Type-signature + plan-identity carry the verification load): NS-04, NS-09, NS-10. Also NS-02 T5.5/T5.6 lanes (those task PRs touch `Querier` / `createSession` files Summary doesn't name; doc-path Decision Log overlap rescues them). **This is a documented limit** — see §5.1 step 3 file-overlap PASS-state note. Misdispatch within a plan-cited Type-signature shape is rare-bug territory; orchestrator heading-grep (§4.3.2) is the load-bearing matcher upstream.
  - **PASS via SKIP** (file-overlap SKIPped per audit Type carve-out): NS-14, NS-15..NS-21
- **1 entry housekept via explicit `--candidate-ns`** (orchestrator's lookup does not auto-find; user runs housekeeper manually): NS-11 (file-overlap SKIPped per cleanup Type carve-out)
- **1 entry already completed** (marker only; no future dispatch): NS-12
- **3 entries explicitly OUT-OF-SCOPE for auto-housekeeping** (manual housekeeping per §4.3.4): NS-13a, NS-13b, NS-22

**Soft-warn third state (`file_overlap_unverifiable_for_sparse_body`)**: defensive future-proofing; **no current §6 entry trips this state** (every entry's References cites at least one `[...](.../NNN-...md)` markdown link which §3a.4 step 1 extracts as a file path).

**Trace table (every entry; verified against HEAD 2026-05-03 via `^### NS-` + `^- Type:` + `^- Status:` greps):**

| NS-XX | Heading (truncated) | Type | Auto-dispatch lookup tuple (§4.3) | Verification (§5.1 step 3) | Outcome |
| --- | --- | --- | --- | --- | --- |
| **NS-01** | `Plan-024 Phase 1 — Rust crate scaffolding` | `code` | `(Plan-024, Phase 1)` → §4.3.2 rule 1 (Plan + Phase exact); 1 match | Type-sig: `code` ↔ diff touches `packages/sidecar-rust-pty/*` ✓; **file-overlap: PASS via file-path** — Summary brace-expands to `packages/sidecar-rust-pty/{Cargo.toml, Cargo.lock, src/{main,framing,protocol,pty_session}.rs, tests/{...}.rs}` + `packages/contracts/src/pty-host-protocol.ts`; diff intersects ✓; plan-identity: heading has `Plan-024` ✓ | ✅ AUTO (file-path) |
| **NS-02** | `Plan-001 Phase 5 Lane A — sessionClient + pg.Pool + I7 (T5.1, T5.5, T5.6)` | `code (recommended split into 3 atomic PRs)` | `(Plan-001, Phase 5, T5.1\|T5.5\|T5.6)` → §4.3.2 rule 2 (Plan + task-id) per precedence; rule 1 (Plan + Phase) conditions also met but suppressed by §4.3.2 precedence clause; 1 match | Type-sig: `code (...)` ↔ each task PR touches `packages/...` ✓; **file-overlap: PASS via file-path for T5.1; PASS via doc-path overlap only for T5.5/T5.6** — Summary names `packages/client-sdk/src/sessionClient.ts` + `.../sessionClient.integration.test.ts` (T5.1 lane), but T5.5 (`SessionDirectoryService` / `Querier`) and T5.6 (`createSession` test) name no paths; their PRs PASS only via the References plan-link `docs/plans/001-shared-session-core.md` Decision Log overlap; plan-identity: heading has `Plan-001` ✓; multi-PR shape: `PRs:` block tick per §3a.1 | ✅ AUTO (mixed: file-path / doc-path-only per task) |
| **NS-03** | `Plan-023-partial Tier 1 — Electron + React skeleton` | `code (single cohesive PR, 7 tasks)` | `(Plan-023-partial, Tier 1)` → §4.3.2 rule 3 (Plan + Tier exact); 1 match | Type-sig: `code (...)` ↔ diff touches `apps/desktop/...` ✓; **file-overlap: PASS via dir-prefix** — Summary contains `apps/desktop/` directory token + `packages/contracts/src/desktop-bridge.ts` file token; diff files start with `apps/desktop/` ✓ (per ACTIONABLE-4); plan-identity: heading has `Plan-023-partial` + `Tier 1` ✓; single-PR shape (per §3a.3 single-PR list) | ✅ AUTO (dir-prefix) |
| **NS-04** | `Plan-001 T5.4 cwd-translator + Plan-024 T-024-2-1 contracts pair` | `code (cross-plan PR pair, internally a 3-step sequence)` | `(Plan-001, T5.4)` OR `(Plan-024, T-024-2-1)` → §4.3.2 rule 2 (Plan + task-id); 1 match | Type-sig: `code (...)` ↔ diff touches `packages/contracts/` + `packages/runtime-daemon/...` ✓; **file-overlap: PASS via doc-path overlap only** — Summary uses type names (`RustSidecarPtyHost`, `NodePtyHost`, `PtyHost`) without source-file paths; References pure-citation. (NS-04's `Upstream:` field at `cross-plan-dependencies.md`:377 inline-names `packages/contracts/src/pty-host.ts` + `packages/runtime-daemon/src/session/spawn-cwd-translator.ts`, but per §3a.4 step 5 scoping note `Upstream:` is NOT an extraction source — these source paths are deliberately discarded.) Extraction yields only `docs/plans/001-shared-session-core.md` + `docs/plans/024-rust-pty-sidecar.md`; diff touches those Decision Logs on governance side ✓; plan-identity: heading has BOTH `Plan-001 T5.4` and `Plan-024 T-024-2-1` ✓ (load-bearing here); multi-PR shape: `PRs:` block tick per §3a.1 | ✅ AUTO (doc-path-only) |
| **NS-05** | `Plan-024 Phase 2 — NodePtyHost` | `code` | `(Plan-024, Phase 2)` → §4.3.2 rule 1; 1 match | Type-sig: `code` ↔ diff touches `packages/runtime-daemon/src/pty/...` ✓; **file-overlap: PASS via dir-prefix** — Summary names `packages/runtime-daemon/src/pty/` directory; diff files start with that prefix ✓ (per ACTIONABLE-4); plan-identity: heading has `Plan-024` ✓ | ✅ AUTO (dir-prefix) |
| **NS-06** | `Plan-001 T5.2 — renderer session-bootstrap` | `code` | `(Plan-001, T5.2)` → §4.3.2 rule 2 (Plan + task-id, no Phase in heading); 1 match | Type-sig: `code` ↔ diff touches `apps/desktop/src/renderer/...` ✓; **file-overlap: PASS via dir-prefix** — Summary names `apps/desktop/src/renderer/src/session-bootstrap/` directory; diff files start with that prefix ✓ (per ACTIONABLE-4); plan-identity: heading has `Plan-001 T5.2` ✓ | ✅ AUTO (dir-prefix) |
| **NS-07** | `Plan-024 Phase 3 — RustSidecarPtyHost` | `code` | `(Plan-024, Phase 3)` → §4.3.2 rule 1; 1 match | Type-sig: `code` ↔ diff touches `packages/runtime-daemon/src/pty/...` ✓; **file-overlap: PASS via dir-prefix** — Summary names `packages/runtime-daemon/src/pty/` directory (same as NS-05); diff files start with that prefix ✓ (per ACTIONABLE-4); plan-identity: heading has `Plan-024` ✓ | ✅ AUTO (dir-prefix) |
| **NS-08** | `Plan-001 T5.3 — sidecar-lifecycle handler` | `code` | `(Plan-001, T5.3)` → §4.3.2 rule 2; 1 match | Type-sig: `code` ↔ diff touches `apps/desktop/src/main/sidecar-lifecycle.ts` ✓; **file-overlap: PASS via file-path** — Summary names exactly that file; diff touches it ✓; plan-identity: heading has `Plan-001 T5.3` ✓ | ✅ AUTO (file-path) |
| **NS-09** | `Plan-024 Phase 4 — CI cross-compile + signing` | `code + governance` | `(Plan-024, Phase 4)` → §4.3.2 rule 1; 1 match | Type-sig: `code + governance` ↔ diff touches BOTH `.github/workflows/` + `packages/sidecar-rust-pty/Cargo.toml` (code side) AND `docs/plans/024-rust-pty-sidecar.md` §Decision Log + `docs/archive/backlog-archive.md` BL-108 archival (governance side) ✓; **file-overlap: PASS via doc-path overlap only** — Summary describes work in prose (cargo-zigbuild matrix, Authenticode, notarization) without naming source files; References extracts `docs/plans/024-rust-pty-sidecar.md` (markdown-link regex) AND `docs/backlog.md` (the bare-path regex matches `../backlog.md` from the `[BL-108](../../backlog.md#bl-108-...)` URL prefix because `#` is not in the bare-path char class; the markdown-link regex itself does NOT match the BL-108 link because it requires `\.md\)` literal which the `#`-bearing URL violates); diff touches `docs/plans/024-rust-pty-sidecar.md` ✓ (note: BL-108 archival lives in `docs/archive/backlog-archive.md`, which is a DIFFERENT file from the extracted `docs/backlog.md` — overlap rides only on the plan-link); plan-identity: heading has `Plan-024` ✓ (load-bearing here, paired with phase-distinctive Type-sig) | ✅ AUTO (doc-path-only) |
| **NS-10** | `Plan-024 Phase 5 — measurement substrate` | `code + governance` | `(Plan-024, Phase 5)` → §4.3.2 rule 1; 1 match | Type-sig: `code + governance` ↔ diff touches `packages/runtime-daemon/src/telemetry/*` (code side) AND `docs/operations/runbooks/*` SLOs (governance side) ✓; **file-overlap: PASS via doc-path overlap only** — Summary describes work in prose (Codex `/resume` ≥ 99% green, sidecar crash-rate telemetry, BL-106 marker resolution) without naming source files; References extracts `docs/plans/024-rust-pty-sidecar.md` (markdown-link regex) AND `docs/backlog.md` (bare-path regex matches `../backlog.md` from the `[BL-106](../../backlog.md#bl-106-...)` URL prefix — same shape as NS-09's BL-108 reference); diff governance side touches `docs/plans/024-rust-pty-sidecar.md` ✓; plan-identity: heading has `Plan-024` ✓ | ✅ AUTO (doc-path-only) |
| **NS-11** | `Plan-007-partial completion cleanup` | `cleanup` | NONE — heading has no `Phase N` / `T<task-id>` / `Tier K` substring; §4.3 lookup returns 0 candidates → would dispatch `--auto-create` if invoked auto. **Manual override required**: user passes `--candidate-ns NS-11` explicitly when running the housekeeper as part of a Plan-007-partial completion PR. | Type-sig: `cleanup` ↔ permissive (any diff allowed; surfaces `cleanup_diff_unverified` concern) ✓; **file-overlap: SKIP** for cleanup Type ✓; plan-identity: SKIPped per cleanup carve-out (heading does have `Plan-007-partial` substring; surfaces `plan_identity_skipped_for_manual_dispatch` concern) ✓ | ✅ EXPLICIT-CANDIDATE |
| **NS-12** | `Plan-001 Phase 5 split amendment + Phase 5 dep alignment` | `governance (doc-only)` | already `completed`; orchestrator's §4.3 lookup excludes entries whose `- Status:` is `` `completed` `` (no future dispatch maps to a completed entry) | n/a (already completed) | N/A marker-only |
| **NS-13a** | `Spec-status promotion gate clarification` | `governance` | NONE — no `Plan-NNN` substring in heading; spec-status promotion is not run via plan-execution skill; §4.3 lookup returns 0 candidates → `--auto-create` would fire BUT the work is governance-only (a CONTRIBUTING.md / template amendment), not a plan-execution dispatch. | n/a (out-of-scope per §4.3.4) | ⛔ OUT-OF-SCOPE |
| **NS-13b** | `Spec-027 \`draft\` → \`approved\` promotion` | `governance (load-bearing)` | NONE — no `Plan-NNN` substring in heading (heading mentions Spec-027, not Plan-NNN); §4.3 lookup returns 0 candidates → would dispatch `--auto-create` BUT spec-promotion PRs are governance-only and don't go through plan-execution skill. | n/a (out-of-scope per §4.3.4) | ⛔ OUT-OF-SCOPE |
| **NS-14** | `Tier 2 plan-readiness audit — Plan-002` | `audit (doc-only)` | `(Plan-002, Tier 2)` → §4.3.2 rule 3 (Plan + Tier); 1 match. **Audit dispatch convention**: orchestrator parses `<tier-K>` from PR-tag `plan-readiness-audit-tier-K-complete` per `plan-implementation-readiness-audit-runbook.md`:209 precedent. | Type-sig: `audit (doc-only)` ↔ diff touches only `docs/plans/002-*.md` + `docs/operations/audit-runbook.md` (no `packages/`) ✓; **file-overlap: SKIP** for audit Type ✓; plan-identity: heading has BOTH `Plan-002` and `Tier 2` ✓. **False-positive guard**: NS-14's body Summary contains `Plan-002 Phase 1-6` (describing 6 parallel Phase audit subagents). §4.3.2 heading-only matching prevents a future Plan-002 Phase 1 implementation PR from false-positive matching NS-14 — the heading does not contain `Phase 1` (only `Tier 2`), so a `(Plan-002, Phase 1)` lookup returns 0 candidates → `--auto-create`, correctly creating a new NS for the implementation work. | ✅ AUTO (audit SKIP) |
| **NS-15..NS-21** | `Tier 3-9 plan-readiness audits` (range form) | `audit (doc-only chain)` | `(any-plan, Tier K)` for K∈{3,4,5,6,7,8,9} → §4.3.2 rule 4 (range-form heading covers tier K); 1 match per K via range arithmetic (per ACTIONABLE-3) | Type-sig: `audit (doc-only chain)` ↔ diff touches only `docs/plans/<NNN>-*.md` (the audited plan for tier K) ✓; **file-overlap: SKIP** for audit Type ✓; plan-identity: range-form heading has `Tier 3-9` covering tier K ✓ (range-arithmetic branch); multi-PR shape: `PRs:` block tick per §3a.1 (one tier per box, K=3..9) | ✅ AUTO (audit SKIP) |
| **NS-22** | `Sibling-doc staleness sweep (cross-plan-deps audit propagation)` | `cleanup (doc-only)` | NONE — no `Plan-NNN` / `Phase` / `Tier` in heading; sweep is emergent multi-plan cleanup; §4.3 lookup returns 0 candidates → `--auto-create` would fire BUT the §5.4 Type-inference rules explicitly halt `NEEDS_CONTEXT` for "diff touches `docs/plans/` of multiple plans without `packages/`" (§5.4 "Otherwise" rule). The user runs the housekeeper manually with `--candidate-ns NS-22` if/when a sweep PR is ready. | n/a (out-of-scope per §4.3.4) | ⛔ OUT-OF-SCOPE |

#### 5.5.1 Falsification protocol

The table above is normative. New corpus entries (NS-23+) MUST be added BEFORE the work that creates them is dispatched, OR the housekeeper's `--auto-create` mode MUST handle them cleanly per §5.4 (and the resulting auto-created entry's row gets backfilled into this table by the next plan-execution PR's housekeeper run).

If a future NS entry shape doesn't fit any of the §4.3.2 four matching rules AND isn't an `--auto-create` Type-inference success AND isn't legitimately out-of-scope per §4.3.4 → the design has a gap. The fix is to extend §4.3.2 (add a new heading-token kind) or §5.4 (add a new diff-shape-to-Type rule) AND backfill the corresponding row(s) in this table. **Surgical patches that widen for one example without re-tracing all existing rows are forbidden** (this is the methodological pattern the third-pass review caught and the §4.1 architectural decision deletes).

The Layer 2 subagent test suite (§8.2) includes a fixture for each non-trivial outcome class — orthogonal axes are (a) §4.3 lookup discriminator and (b) §5.1 step 3 file-overlap discriminator:

- **Lookup axis**: AUTO-PASS via Plan+Phase (rule 1; NS-01/05/07/09/10), AUTO-PASS via Plan+task-id (rule 2; NS-06/08), AUTO-PASS via Plan+Phase+task-id (rules 1+2; NS-02), AUTO-PASS via Tier-K substring (rule 3; NS-14 precedent), AUTO-PASS via range-form Tier-K arithmetic (rule 4; NS-15..NS-21 + ACTIONABLE-3), EXPLICIT-CANDIDATE PASS (NS-11), OUT-OF-SCOPE manual fall-through (NS-22), false-positive guard (Plan-002 Phase 1 hypothetical).
- **File-overlap axis**: PASS via file-path (NS-01/02-T5.1/08), PASS via dir-prefix (NS-03/05/06/07; ACTIONABLE-4), PASS via doc-path overlap only (NS-04/09/10/02-T5.5/T5.6 — documented limit), PASS via SKIP for cleanup/audit Types (NS-11/14/15..NS-21), `file_overlap_zero` halt (synthetic fixture: pass `--candidate-ns NS-01` with a Plan-007 PR diff), `file_overlap_unverifiable_for_sparse_body` SOFT-WARN (synthetic fixture: NS entry whose References + Summary contain no `.md` link AND no source-file token AND no directory token — defensive future-proofing; no current entry triggers it).

Re-running this fixture set after any §4.3 / §5.1 / §5.4 edit re-validates the table mechanically.

## 6. Data flow

End-to-end sequence with failure branches:

```
        ┌────────────────────────────────┐
        │ Phase E entry: PR ready,       │
        │ CI green + Codex 👍 + 0 threads│
        └───────────────┬────────────────┘
                        │
                        ▼
   Orchestrator candidate-lookup (per §4.3): scan §6 headings,
   count matches against PR-metadata tuple (plan|task|tier).
                        │
        ┌───────────────┼────────────────────┐
        │               │                    │
   0 candidates    1 candidate         2+ candidates
        │               │                    │
        ▼               ▼                    ▼
   Dispatch with   Dispatch with         HALT: NEEDS_CONTEXT
   --auto-create   --candidate-ns        (surface candidate list
        │          NS-XX                  for user disambiguation;
        │               │                  no script invocation)
        └───────┬───────┘
                ▼
   node post-merge-housekeeper.mjs <PR> [--plan NNN] [--phase N] [--task TASK]
                                        [--tier K] [--pr-tag TAG]
                                        {--candidate-ns NS-XX | --auto-create}
                                  (per §5.1 invocation header)
                        │
        ┌───────┬───────┼────────┬────────┬────────┐
        │       │       │        │        │        │
     exit 0  exit 1  exit 2   exit 3   exit 4   exit 5
   (success) (NS-XX (verif.   (no plan (multi-   (schema
             not in failed)   checklist PR, no    violation
             §6 —              found)    --task)   OR auto-
             ortho-                                create dup-
             gonal                                 title)
             misdis-
             patch)
        │       │       │        │        │        │
        │       ▼       ▼        │        ▼        ▼
        │    HALT:   HALT:    continue HALT:    subagent dispatched
        │    surface BLOCKED  (subagent NEEDS_  (carries violations in
        │    misdis- via      flags    CONTEXT  schema_violations →
        │    patch   subagent concerns          surfaces in concerns →
        │           surfacing entry              returns RESULT: BLOCKED)
        │           of verif-
        │           ication_
        │           failures
        │
        ▼
   Validate manifest (script-stage invariants)
   (covers --auto-create exit-0 path AND --candidate-ns exit-0 path —
   both write the manifest the orchestrator validates)
                                │
                       ┌────────┴────────┐
                       │                 │
                     valid          invalid ──► HALT: regen-script-output bug
                                                (surface manifest path + missing fields)
                       │
                       ▼
            Dispatch plan-execution-housekeeper subagent
            (orchestrator passes manifest path + script exit code via prompt)
                       │
                       ▼
       Subagent reads manifest + affected files,
       performs semantic work (incl. composing Status: prose),
       edits files, rewrites manifest
                       │
              ┌────────┴───────┬────────────┬──────────┐
              │                │            │          │
            DONE         DONE_WITH_     NEEDS_     BLOCKED ──► HALT: surface
                         CONCERNS       CONTEXT
              │                │            │
              │                │            ▼
              │                │       HALT: surface to user
              │                │
              │           (proceed; concerns logged in manifest)
              │                │
              └────────┬───────┘
                       ▼
       Validate manifest (subagent-stage invariants — incl. no `<TODO ...>` placeholders left)
                       │
              ┌────────┴────────┐
              │                 │
            valid          invalid ──► round-trip to subagent
                                        (re-dispatch with specific gap,
                                         same pattern as ACTIONABLE finding)
              │
              ▼
       Append Progress Log (existing Phase E step)
              │
              ▼
       git add docs/architecture/cross-plan-dependencies.md
               docs/plans/<NNN>-*.md
               [+ any other affected_files]
       git commit -m "chore(repo): housekeeping for PR #N — NS-XX completion"
                       │
                       ▼
                    git push
                       │
                       ▼
       gh pr merge --squash --delete-branch
                       │
                       ▼
       git switch develop && git pull --ff-only
                       │
                       ▼
                    Phase E DONE
```

### 6.1 Why Progress Log moves AFTER the housekeeper stages

Today, Phase E's first step is "Append Progress Log" — written as its own commit. The new ordering moves Progress Log to **after** the housekeeper stages, in the **same commit** as the housekeeping edits. Three reasons:

1. **Atomic state.** A reader of `develop` sees either "Phase N shipped + §6 reflects it + plan checklist ticked + Progress Log says so" OR none of those. No intermediate state where Progress Log claims completion but §6 hasn't caught up.
2. **Fewer commits to review.** One housekeeping commit per PR is easier to review than two (one for Progress Log, one for housekeeping). Squash-merge collapses both either way, but the pre-merge inspection is cleaner.
3. **Manifest-driven Progress Log enrichment.** The housekeeper's manifest carries facts (NS-XX flipped, mermaid recolored, line-cites repaired, completion-prose composed) that the Progress Log can cite. Putting Progress Log after the manifest is finalized lets the orchestrator use the manifest as a Progress-Log fact source.

### 6.2 What the user sees during a happy-path run

```
[orchestrator] Phase E starting...
[orchestrator] Running post-merge-housekeeper.mjs PR=30 plan=024 phase=1...
[script]       ✓ Matched NS-01 (single-PR shape)
[script]       ✓ Status flip: `todo` → `completed` (placeholder prose pending)
[script]       ✓ Mermaid class swap: NS01 :::ready → :::completed
[script]       ✓ Plan-024 §Phase 1 Done Checklist: 5 items ticked
[script]       Manifest written: .agents/tmp/housekeeper-manifest-PR30.json
[orchestrator] ✓ Manifest valid (script stage)
[orchestrator] Dispatching plan-execution-housekeeper subagent...
[subagent]     ✓ Composed completion prose for NS-01 Status:
[subagent]     ✓ Re-derived §6 ready set (NS-04 + NS-08 newly ready)
[subagent]     ✓ Repaired 2 line cites in downstream docs
[subagent]     ✓ Set-quantifier claim verified (still true)
[subagent]     ✓ No NS auto-create needed (manifest exit 0)
[subagent]     ✓ No unannotated NS-referenced-file PRs detected
[subagent]     RESULT: DONE
[orchestrator] ✓ Manifest valid (subagent stage)
[orchestrator] ✓ Progress Log appended
[orchestrator] Committing housekeeping...
[orchestrator] ✓ Pushed to origin
[orchestrator] ✓ Squash-merged PR #30 to develop
[orchestrator] ✓ Pulled develop
[orchestrator] Phase E complete.
```

## 7. Error handling & recovery

### 7.1 Failure taxonomy

Exit codes mirror §5.1 invocation-header definitions verbatim — this taxonomy is the consumer-side view of the same enumeration.

| Failure class | Where it surfaces | Recovery path |
| --- | --- | --- |
| Script exit 0 — `--candidate-ns` mode succeeded | Script stage | Continue to manifest validation; mechanical edits applied |
| Script exit 0 — `--auto-create` mode succeeded | Script stage | Continue to manifest validation; subagent composes new NS body in stage 2 (per §5.4). NOTE: AUTO-CREATE is dispatched by orchestrator (per §4.3 zero-candidate path), not by a script-side exit code; the script-side outcome is exit 0 success. |
| Script exit 1 (`--candidate-ns NS-XX` not found in §6) | Script stage | HALT — surface as orchestrator misdispatch (the orchestrator's §4.3 lookup named an NS-XX that doesn't exist in §6; either the orchestrator parsed §6 with a stale snapshot, or the user's manual `--candidate-ns` arg names a non-existent entry). Re-run §4.3 lookup against current §6; either correct the candidate or the user disambiguates. |
| Script exit 2 (verification failed: Type-signature, file-overlap, or plan-identity mismatch) | Script stage | Subagent dispatched with `verification_failures` populated; subagent surfaces them in `concerns` with `kind: type_signature_mismatch` / `file_overlap_zero` / `plan_identity_missing` per §5.1 step 3, returns `RESULT: BLOCKED`. Orchestrator halts to user per `references/failure-modes.md` § BLOCKED routing. The fix is usually an orchestrator-misdispatch correction (different `--candidate-ns`) or a corpus correction (NS heading or References don't reflect the diff's actual shape). |
| Script exit 3 (no plan checklist found / already fully ticked) | Script stage | Continue; subagent flags `concerns` entry with `kind: plan_checklist_not_found` (e.g., the plan §Phase N section has no Done Checklist sub-section, or all boxes are already ticked from a prior partial run) |
| Script exit 4 (multi-PR entry, no `--task` arg) | Script stage | HALT → NEEDS_CONTEXT (orchestrator should have passed `--task` for multi-PR Lane entries per §4.3.1; dispatch bug — surface to user with candidate's `PRs:` block to identify which task this PR ships) |
| Script exit 5 — schema violation in matched NS (`--candidate-ns` mode) | Script stage | Subagent dispatched with `schema_violations` populated; subagent surfaces them in `concerns` with `kind: schema_violation` + structured remediation hint, returns `RESULT: BLOCKED`. Orchestrator halts to user per `references/failure-modes.md` § BLOCKED routing. |
| Script exit 5 — auto-create would duplicate existing heading title (`--auto-create` mode) | Script stage | Subagent dispatched with `schema_violations` populated (kind: `auto_create_duplicate_title`); subagent surfaces NEEDS_CONTEXT for user disambiguation — usually means the orchestrator's §4.3 lookup missed an existing candidate that should have triggered `--candidate-ns` instead. |
| Script exit ≥6 (crash, IO error, arg-validation failure) | Script stage | HALT → surface stderr verbatim; user investigates. Arg-validation failures include: passing both `--candidate-ns` and `--auto-create`, passing neither, missing at-least-one-of `--plan` / `--task` / `--tier` for non-cleanup/governance Types (per §5.1 step 0). |
| Manifest validation fail (script stage) | Orchestrator post-script | HALT → script bug; surface manifest path + missing fields |
| Subagent NEEDS_CONTEXT | Subagent return | HALT → surface subagent's question to user (e.g., §5.4 "Otherwise → halt NEEDS_CONTEXT" for AUTO-CREATE diff-shape that doesn't fit a clean Type-classification rule) |
| Subagent BLOCKED | Subagent return | HALT → surface subagent's blocker (covers schema-violation halts, verification-failure halts, AND any other BLOCKED return) |
| Subagent DONE_WITH_CONCERNS | Subagent return | Continue; concerns logged in manifest + PR Review Notes (e.g. unannotated NS-referenced files) |
| Manifest validation fail (subagent stage) | Orchestrator post-subagent | Round-trip to subagent (re-dispatch with specific gap) |
| Subagent sprawls beyond `affected_files` | Validation invariant | Round-trip: "X edited but not declared — extend `affected_files` with justification or revert" |
| Pre-commit hook fails on housekeeping commit | git commit step | Standard hook recovery: fix → restage → new commit (NOT amend, per CONTRIBUTING.md) |
| Push rejected (race vs concurrent push) | git push step | HALT — concurrent activity on PR branch is unexpected; surface to user |

### 7.2 Resume after crash mid-Phase E

If a session ends or the orchestrator crashes mid-pipeline, recovery on next invocation walks **git first, manifest second**:

```
Resume diagnostic (run on Phase E re-entry):

1. Is the housekeeping commit present?
   git log --oneline -1 --grep="^chore(repo): housekeeping for PR #<N>"
   ├── YES + pushed: skip to "merge if not merged"
   ├── YES + unpushed: skip to "git push"
   └── NO: continue to step 2

2. Is the manifest present at .agents/tmp/housekeeper-manifest-PR<N>.json?
   ├── NO: re-run script (idempotent — overwrites prior manifest)
   └── YES: continue to step 3

3. Read manifest.result:
   ├── null: re-dispatch subagent (manifest is script-only)
   ├── DONE | DONE_WITH_CONCERNS: skip to "Append Progress Log → git add + commit"
   ├── NEEDS_CONTEXT | BLOCKED: surface to user (same as fresh halt)
   └── any other value: treat as malformed, halt
```

The script is **idempotent on its own output**. Re-dispatching the subagent against an existing manifest is safe because the subagent rewrites the manifest entirely from re-reading file state.

### 7.3 Round-trip mechanics (manifest as a "self-review")

When manifest validation fails after the subagent stage, the orchestrator builds a follow-on dispatch prompt:

```
Your prior dispatch wrote a manifest at <path> but it failed orchestrator invariant <X>.
Specific gap: <human-readable description, e.g., "ready_set_re_derivation listed in
semantic_work_pending but no corresponding entry in semantic_edits or concerns" or
"`<TODO subagent prose>` placeholder still present in NS-01 Status: line">.

Re-read the manifest, perform the missing semantic work (or add a concerns entry
explaining why it's deferred), rewrite the manifest, return RESULT: DONE.

Do NOT re-do work already correctly recorded in semantic_edits — only address the gap.
```

This is the **same shape** as a reviewer ACTIONABLE finding round-trip. The orchestrator already has this dispatch pattern wired for Phase B/C/D — Phase E reuses it.

### 7.4 User-facing failure surface

Orchestrator never auto-resolves NEEDS_CONTEXT or BLOCKED. Surfaces a structured halt message. Two representative failure paths:

**(1) Subagent NEEDS_CONTEXT during AUTO-CREATE — diff signature doesn't fit a Type-classification rule (per §5.4 "Otherwise" halt):**

```
[orchestrator] Phase E HALTED at housekeeper subagent stage.

Reason: subagent returned NEEDS_CONTEXT
Subagent's question:
  "AUTO-CREATE mode dispatched (orchestrator's §4.3 lookup found 0 candidates for
   --plan 029 --phase 2). Composing the new NS entry, but the diff signature doesn't
   fit any §5.4 Type-classification rule: touches docs/plans/029-*.md AND
   docs/plans/030-*.md AND no packages/ files. Per §5.4 'Otherwise → halt
   NEEDS_CONTEXT': should this be a multi-plan governance entry, or did Plan-029
   Phase 2 incorrectly modify Plan-030?"

Manifest:    .agents/tmp/housekeeper-manifest-PR42.json
Resume with: continue plan-execution Plan-029
            (after answering subagent's question; pass answer in resume prompt)
```

**(2) Orchestrator misdispatch — script exit 1 (`--candidate-ns NS-XX` not found in §6):**

```
[orchestrator] Phase E HALTED before housekeeper subagent stage.

Reason: script exit 1 (--candidate-ns NS-99 not found in §6)
Diagnostic:
  Orchestrator dispatched the housekeeper with `--candidate-ns NS-99 --plan 024
  --phase 1`, but no `### NS-99` heading exists in cross-plan-dependencies.md §6.
  Possible causes:
    (a) Orchestrator's §4.3 lookup ran against a stale §6 snapshot (re-pull develop
        and re-dispatch).
    (b) User passed `--candidate-ns NS-99` manually with a typo (likely meant NS-09).
    (c) §6 lost an entry between the lookup and the dispatch (concurrent edit on
        develop — unexpected).
Manifest:    (none — script aborted before manifest write)
Resume with: re-run §4.3 lookup, then continue plan-execution Plan-024
            (or pass corrected `--candidate-ns NS-XX` in resume prompt)
```

For schema-violation halts (subagent returned BLOCKED with `kind: schema_violation` concerns):

```
[orchestrator] Phase E HALTED at housekeeper subagent stage.

Reason: subagent returned BLOCKED
Schema violations on NS-15 (1):
  - kind: schema_violation
    field: PRs:
    detail: Multi-PR Type qualifier present ("audit (doc-only chain)") but no `- PRs:`
            sub-field. Schema §3a.1 requires explicit `- PRs:` block on multi-PR entries.
    remediation_hint: Add `- PRs:` block enumerating each tier's audit task-id, with
                      already-merged tiers ticked.

Manifest:    .agents/tmp/housekeeper-manifest-PR47.json
Resume with: edit cross-plan-dependencies.md NS-15 per remediation_hint, then re-dispatch.
```

### 7.5 Manifest hand-edit / trust boundary

Between the script stage and the subagent stage, the user MAY hand-edit the manifest (e.g., to correct an erroneous `matched_entry`, or to add a `warnings` entry the subagent should consider). The orchestrator's policy:

- **Trust the manifest as the contract.** The orchestrator does not re-run the script after a manual edit; the manifest is the input the subagent sees.
- **Re-validate structure (invariants), not semantic content.** Orchestrator checks the manifest still satisfies post-script invariants (mechanical_edits populated per script_exit_code, semantic_work_pending non-empty, result === null). It does NOT verify the user's edits are semantically correct — that's the user's responsibility when they hand-edit.
- **Hand-edits between subagent and commit are also trusted.** Same rule — user edits the JSON, orchestrator validates structure, proceeds.
- **Hand-edits to actual repo files between stages are NOT trusted.** If the user edits `cross-plan-dependencies.md` between script and subagent runs, the subagent re-reads file state from disk and may make different decisions than the manifest implies. The user is responsible for either reconciling the manifest OR re-running the script if they edit affected files mid-pipeline.

This boundary keeps the manifest as the single contract between stages without requiring the orchestrator to police the user's manual interventions.

## 8. Testing

### 8.1 Script (Layer 1) — fixture corpus + `node:test`

Test surface: `(args, repo state) → (file edits, manifest, exit code)`.

**Test framework.** Existing skill tests (`scripts/__tests__/preflight.test.mjs`, `validate-review-response.test.mjs`) use `node:test` + `node:assert/strict`, run via `node --test`. The housekeeper tests follow the same pattern — no new framework dependency.

**Fixture pattern divergence.** Existing skill tests use inline `mkdtempSync` with string-literal markdown bodies because the inputs are small (10–30 lines of plan markdown). The housekeeper inputs are large (full §6 mermaid graph, multi-page plan files, multi-NS scenarios) — inline string literals would be ~200 lines each, dwarfing the test logic. Justified divergence: directory-based fixture corpus for the 10 scenarios; the test harness still uses `node:test` + `mkdtempSync` internally to snapshot fixture inputs to a temp dir before running the script.

```
.claude/skills/plan-execution/scripts/__tests__/
├── post-merge-housekeeper.test.mjs
└── fixtures/
    ├── 01-single-pr-happy-path/
    │   ├── input/
    │   │   ├── docs/architecture/cross-plan-dependencies.md
    │   │   └── docs/plans/024-rust-pty-sidecar.md
    │   ├── expected/
    │   │   ├── docs/architecture/cross-plan-dependencies.md
    │   │   └── docs/plans/024-rust-pty-sidecar.md
    │   ├── args.json
    │   └── expected-manifest.json
    ├── 02-multi-pr-tick-only/                    # ≥1 unchecked → in_progress
    ├── 03-multi-pr-completion/                    # all ticks checked → completed
    ├── 04-multi-pr-blocked-upstream/              # blocked-override fires
    ├── 05-exit-1-no-ns-match/
    ├── 06-exit-2-multi-ns-match/
    ├── 07-exit-3-no-checklist/
    ├── 08-exit-4-multi-pr-no-task-id/
    ├── 09-exit-5-schema-violation-malformed-prs/
    └── 10-mermaid-class-attachment-variant/      # `:::ready` followed by edge syntax
```

Test runner pattern (`node:test`):

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHousekeeper } from "../post-merge-housekeeper.mjs";
import {
  listFixtures,
  readArgs,
  readExpectedManifest,
  expectFilesEqual,
} from "./helpers/fixture-loader.mjs";

for (const fixture of listFixtures("./fixtures")) {
  test(`post-merge-housekeeper: ${fixture.name}`, async () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), "housekeeper-"));
    cpSync(fixture.inputDir, tmpRepo, { recursive: true });

    const result = await runHousekeeper({
      ...readArgs(fixture),
      repoRoot: tmpRepo,
    });

    assert.equal(result.exitCode, fixture.expectedExitCode);
    expectFilesEqual(tmpRepo, fixture.expectedDir);
    assert.deepEqual(
      JSON.parse(readFileSync(result.manifestPath, "utf8")),
      readExpectedManifest(fixture),
    );
  });
}
```

Fixtures use truncated real-world snippets (real cross-plan-dependencies.md §6 trimmed to relevant entries — preserving the bullet+backtick sub-field shape verbatim per §1.1.1; real plan §Done Checklist) — catches regressions against actual heading-style + sub-field-shape + mermaid-class-attachment variants.

Pure parser functions (`parseNsHeading`, `parseSubFields`, `parsePRsBlock`, `computeStatusFromPRs`, `extractPlanFromEntry`) get separate `node:test` cases that exercise edge cases without fixture overhead — same shape as `preflight.test.mjs` lines 33–80.

### 8.2 Subagent (Layer 2) — prompt construction + manifest validation

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHousekeeperPrompt,
  validateManifestSubagentStage,
} from "../housekeeper-orchestrator-helpers.mjs";

test("orchestrator builds correct prompt for exit code 0 + happy-path manifest", () => {
  const manifest = readFixtureManifest("01-single-pr-happy-path");
  const prompt = buildHousekeeperPrompt({ manifest, scriptExitCode: 0, prNumber: 30 });
  assert.match(prompt, /happy-path mode/);
  // ...specific field-presence checks
});

test("orchestrator builds AUTO-CREATE prompt for exit code 1", () => {
  const manifest = readFixtureManifest("05-exit-1-no-ns-match");
  const prompt = buildHousekeeperPrompt({ manifest, scriptExitCode: 1, prNumber: 30 });
  assert.match(prompt, /AUTO-CREATE mode/);
});

test("orchestrator builds schema-violation prompt for exit code 5 (subagent returns BLOCKED)", () => {
  const manifest = readFixtureManifest("09-exit-5-schema-violation");
  const prompt = buildHousekeeperPrompt({ manifest, scriptExitCode: 5, prNumber: 30 });
  assert.match(prompt, /schema_violations/);
  assert.match(prompt, /RESULT: BLOCKED/);
});

test("manifest with all semantic_work_pending addressed → valid", () => {
  const manifest = loadFixture("valid-complete-manifest.json");
  assert.deepEqual(validateManifestSubagentStage(manifest), { valid: true });
});

test("manifest with unaddressed pending work → invalid + specific gap", () => {
  const manifest = loadFixture("invalid-missing-ready-set-re-derivation.json");
  assert.deepEqual(validateManifestSubagentStage(manifest), {
    valid: false,
    gaps: [
      "ready_set_re_derivation listed in semantic_work_pending but absent from semantic_edits and concerns",
    ],
  });
});

test("manifest with leftover <TODO subagent prose> placeholder → invalid", () => {
  const manifest = loadFixture("invalid-leftover-todo-placeholder.json");
  // helper reads the affected_files list and greps each for the placeholder string
  assert.deepEqual(validateManifestSubagentStage(manifest), {
    valid: false,
    gaps: [
      "<TODO subagent prose> placeholder still present in docs/architecture/cross-plan-dependencies.md NS-01 Status: line",
    ],
  });
});
```

Catches: prompt drift, missing context fields, wrong exit-code-to-mode mapping, validation logic regressions, leftover placeholder strings.

### 8.3 Subagent (Layer 3) — manual end-to-end

Real fixture inputs, real subagent invocation, capture the manifest output:

```bash
# Manual test runner (NOT in CI):
node .claude/skills/plan-execution/scripts/__tests__/run-subagent-against-fixtures.mjs

# For each fixture:
#   1. Snapshot input dir to temp
#   2. Run script → produce manifest
#   3. Invoke subagent against manifest (real LLM call)
#   4. Validate output manifest against invariants
#   5. Diff produced files vs expected files
#   6. Report pass/fail per fixture
```

**Not in CI** because: (a) real LLM calls cost real money, (b) subagent output is non-deterministic across runs, (c) maintaining a "blessed" expected output requires re-recording every time the subagent prompt changes.

**Run cadence:** before merging any change to `plan-execution-housekeeper.md` or its prompt template.

### 8.4 Live-PR validation (Layer 4) — validation, not testing

After shipping the housekeeper, **the next 3 plan-execution PRs serve as live validation:**

1. Each PR's `housekeeper-manifest-PR<N>.json` is captured for inspection. The current `lefthook.yml` does NOT prune `.agents/tmp/`; manifests persist on the local working copy until the user manually deletes them. The audit-copy concern from earlier drafts (Q11.5) is therefore moot — manifests are already inspectable post-merge in the local clone. CI runners build fresh worktrees per run, so manifest files do not leak through CI.
2. After merge, manually inspect: status flip correct (atomic value backticked + prose annotation matches NS-12 shape)? mermaid class attachment right? `PRs:` block recompute matches §3a.2 matrix? ready-set prose accurate? line cites all caught? auto-created NS entries (if any) shaped correctly per §5.4? schema-violation halts (if any) carry structured remediation hints?
3. Anything wrong → file BL-NNN with the manifest as evidence; iterate on script logic OR subagent prompt.

**Exit criteria for "housekeeper validated":** 3 consecutive PRs with zero manual housekeeping touch-ups required after merge.

### 8.5 What we explicitly do NOT test

- **Subagent's semantic correctness in isolation** — "did it re-derive the ready set right?" is validated by Layer 2's invariant check + Layer 4 (real-PR validation). Re-deriving the ready set in a unit test would mean writing a parallel implementation of "what does ready mean" — that's the subagent's whole job.
- **Round-trip behavior with the orchestrator** — too coupled to test in isolation; exercised by Layer 4.
- **Composition quality of the subagent's `<TODO subagent prose>` replacement** — Layer 2 validates the placeholder is gone; the prose's quality is judged at Layer 4 by reading the resulting NS entry's Status: line.

### 8.6 Test infrastructure summary

| Layer | Tool | Runs in CI? | Owner |
| --- | --- | --- | --- |
| Script fixture tests (Layer 1) | `node:test` | Yes — see §10.4 CI wiring | Skill maintainer |
| Pure parser tests (Layer 1) | `node:test` | Yes — same wiring | Skill maintainer |
| Prompt construction tests (Layer 2) | `node:test` | Yes — same wiring | Skill maintainer |
| Manifest validation tests (Layer 2) | `node:test` | Yes — same wiring | Skill maintainer |
| Subagent E2E (Layer 3) | Custom node runner | No (manual, pre-merge) | Skill maintainer |
| Live-PR validation (Layer 4) | Manual inspection | No (3-PR observation window) | User |

The "Yes — see §10.4 CI wiring" rows depend on the new CI step being added (§10.4) — `pnpm test` today does NOT run `node --test .claude/skills/plan-execution/scripts/__tests__/*`, so a new GitHub Actions step is required.

## 9. File layout

### 9.1 New files

```
.claude/agents/
└── plan-execution-housekeeper.md            ⬅️ NEW (7th subagent role; color: blue)

.claude/skills/plan-execution/
├── scripts/
│   ├── post-merge-housekeeper.mjs           ⬅️ NEW
│   └── __tests__/
│       ├── post-merge-housekeeper.test.mjs  ⬅️ NEW
│       ├── helpers/
│       │   └── fixture-loader.mjs           ⬅️ NEW (shared helper for the 10 fixtures)
│       └── fixtures/                         ⬅️ NEW (10 scenarios)
│           ├── 01-single-pr-happy-path/
│           ├── 02-multi-pr-tick-only/
│           ├── 03-multi-pr-completion/
│           ├── 04-multi-pr-blocked-upstream/
│           ├── 05-exit-1-no-ns-match/
│           ├── 06-exit-2-multi-ns-match/
│           ├── 07-exit-3-no-checklist/
│           ├── 08-exit-4-multi-pr-no-task-id/
│           ├── 09-exit-5-schema-violation-malformed-prs/
│           └── 10-mermaid-class-attachment-variant/
└── references/
    └── post-merge-housekeeper-contract.md   ⬅️ NEW (full manifest schema, exit codes,
                                                     validation invariants, recovery diagnostic,
                                                     completion-rule matrix from §3a.2,
                                                     file-reference extraction heuristic from §3a.4)
```

### 9.2 Moved files

| From | To | Reason |
| --- | --- | --- |
| `.claude/skills/plan-execution/scripts/preflight-contract.md` | `.claude/skills/plan-execution/references/preflight-contract.md` | Markdown contract docs belong in `references/`, not `scripts/`. Keeps the layout uniform with the new `post-merge-housekeeper-contract.md`. |

### 9.3 Required edits to existing files

| File | Edit |
| --- | --- |
| `.claude/skills/plan-execution/scripts/preflight.mjs` line 3 | Header comment path reference |
| `.claude/skills/plan-execution/scripts/preflight.mjs` line 537 | Error message path reference |
| `.claude/skills/plan-execution/SKILL.md` line 29 | "Six subagent roles" → "Seven subagent roles"; append `plan-execution-housekeeper` to the role list |
| `.claude/skills/plan-execution/SKILL.md` line 142 | `preflight-contract.md` citation path |
| `.claude/skills/plan-execution/SKILL.md` line 507 | `preflight-contract.md` citation path |
| `.claude/skills/plan-execution/SKILL.md` line 518 | `preflight-contract.md` citation path |
| `.claude/skills/plan-execution/SKILL.md` Phase E section | Wire the two new pipeline steps + manifest validation gates; reorder so Progress Log appends AFTER housekeeper stages (per §6.1) |
| `.claude/skills/plan-execution/SKILL.md` Reference Files section | Add `references/post-merge-housekeeper-contract.md` to the documented reference-files list |
| `.claude/skills/plan-execution/references/state-recovery.md` | Add "Phase E housekeeping recovery" with the diagnostic from §7.2 + cross-link to `post-merge-housekeeper-contract.md`. NOTE: the existing line 174 reference to `.agents/tmp/` lifecycle is inconsistent with `lefthook.yml` (no prune job) — flag the inconsistency in this PR; defer reconciliation (either add the lefthook job or reword the doc) to a follow-on cleanup PR since changing the lifecycle is out of this spec's scope (§2.2). |
| `.claude/skills/plan-execution/references/failure-modes.md` | Add row for "subagent edits files outside manifest's affected_files declaration" with round-trip pattern; cross-link the BLOCKED routing for housekeeper schema-violation halts (no new exit-state introduced). |
| `lefthook.yml` | OPTIONAL — add `.agents/tmp/` cleanup job (see §10.5). If skipped (recommended for V1), keep §8.4's "manifests persist locally" semantics. |

## 10. Migration / rollout

### 10.1 Build-and-ship sequence

The housekeeper is itself a plan-execution-shaped change. The sequence is **four PRs**:

1. **PR 1 — Schema amendment (NS-23 itself + the §6 amendment).** Author NS-23 in §6 (per §3a.3 shape). Migrate NS-02, NS-04, NS-15..NS-21 to the `PRs:` shape per §3a.1. **Manually housekept** (housekeeper does not exist yet) — NS-23's `- Status:` flips to `` `completed` `` inline, recording the resolution in the same NS-12-shaped parenthetical. This PR's merge is the last manual housekeeping cycle; PRs 2 onward enjoy automation only AFTER PR 4 ships.
2. **PR 2 — Move + path updates.** Move `scripts/preflight-contract.md` → `references/preflight-contract.md`. Update 5 inline references. Trivial; no behavior change. (Could be folded into PR 3 if the user prefers.)
3. **PR 3 — Author the script + tests.** `post-merge-housekeeper.mjs` + 10 fixture scenarios + `__tests__/post-merge-housekeeper.test.mjs` + `helpers/fixture-loader.mjs`. CI green on Layer 1 tests via the new wiring (§10.4).
4. **PR 4 — Author the subagent + wire SKILL.md + orchestrator-side amendments.** `.claude/agents/plan-execution-housekeeper.md` + `references/post-merge-housekeeper-contract.md` + SKILL.md edits + state-recovery.md + failure-modes.md. **Critical orchestrator-side scope (per §4.3):**
   - SKILL.md Phase E section gets new procedural prose: "Before dispatching the housekeeper, scan §6 for candidate NS-XX(s) using the heading-only matching rules in `housekeeper-design.md` §4.3.2; resolve to `--candidate-ns NS-XX` (1 match), `--auto-create` (0 matches), or halt NEEDS_CONTEXT (2+ matches) per §4.3.3."
   - SKILL.md "Six subagent roles" prose at line 29 → "Seven subagent roles" + housekeeper row appended.
   - `references/state-recovery.md` gains an appendix documenting the lookup rules + dispatch decision tree + out-of-scope NS list (mirroring §4.3.2 / §4.3.3 / §4.3.4 verbatim — single source of truth for the runtime prose).
   - Layer 2 tests added (prompt construction + manifest validation, **including verification halt cases for `type_signature_mismatch` / `file_overlap_zero` / `plan_identity_missing`** per §5.1 step 3).
   - CI green. Manual Layer 3 validation runs before merge.

Suggested PR boundaries: each of the four can be a separate PR, OR PRs 2–4 can be bundled into one large PR if review bandwidth permits. PR 1 MUST be its own PR (it's the prerequisite that establishes the schema the housekeeper depends on). PR 4 SHOULD NOT be split because the script + subagent + orchestrator-side amendments must ship atomically — partial deployment (e.g., subagent without orchestrator's §4.3 lookup wired) leaves Phase E in an inconsistent state where the script gets invoked without the candidate-resolution preamble.

### 10.2 Eat-your-own-dog-food bootstrap

The bootstrap is **not** a self-application: PR 4 ships the housekeeper, but PR 4 itself is housekept manually (one final manual cycle, since the housekeeper is being introduced _by_ PR 4 — it doesn't exist in the merged tree until PR 4 lands).

The first AUTO-RUN happens on the **next** plan-execution PR after PR 4 merges. That PR's Phase E will dispatch the housekeeper for the first real-world invocation, against a non-trivial NS entry (likely NS-01 / Plan-024 Phase 1 since it's at the top of the dispatch queue). The first AUTO-RUN exercises the **full pipeline** end-to-end: orchestrator's §4.3 §6 lookup (must auto-find NS-01 from the merged PR's `(Plan-024, Phase 1)` metadata per §5.5 verification table row 1) → script verification (Type-sig + file-overlap + plan-identity per §5.1 step 3) → mechanical edits (status flip + mermaid recolor + plan-checklist tick) → subagent semantic stage (ready-set re-derivation + line-cite sweep + completion prose). Failure at any stage halts Phase E with the canonical exit-state taxonomy (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED per `references/failure-modes.md`); the user inspects + iterates per §10.3 validation window.

PRs 1, 2, 3 also do not have housekeeper coverage:

- PR 1 is by-definition manual (housekeeper doesn't exist; NS-23 flip is recorded inline per §3a.3).
- PR 2 is too small to warrant its own NS entry (file move with no §6 implications).
- PR 3 ships the script but not the subagent — the orchestrator can't dispatch a non-existent subagent, so PR 3's own merge is also manually housekept.

This means **four manual housekeeping cycles** during the rollout (one per PR), then auto from PR 5 onward. The four-cycle cost is acceptable: it's bounded, predictable, and forces dogfood-validation of each layer before the next builds on it.

### 10.3 Validation window

After housekeeper ships and the first NS-XX-tracked PR completes Phase E:

- Inspect manifest output (still on local clone post-merge per §8.4)
- Inspect resulting §6 / mermaid / plan-checklist edits
- Inspect downstream-doc line cites + set-quantifier claims
- Inspect `Status:` line completion prose for NS-12-shape compliance (backticked atomic + parenthetical resolution narrative)
- File BL-NNN if anything is wrong; iterate

**Exit criteria for "housekeeper validated":** 3 consecutive PRs with zero manual housekeeping touch-ups after merge.

### 10.4 CI wiring (corrects earlier draft's incorrect `pnpm test` claim)

`pnpm test` at repo root invokes `turbo run test`, which discovers tests in workspace packages declared in `pnpm-workspace.yaml`. `.claude/skills/plan-execution/scripts/__tests__/` is NOT a workspace package, so `pnpm test` does NOT run the existing `preflight.test.mjs` either — those tests are currently runnable manually via `node --test ...` but have no CI gate.

The housekeeper PR series adds CI wiring **as part of PR 3** (the script + tests PR). Two valid shapes:

- **(a) GitHub Actions step.** Add a step to `.github/workflows/ci.yml` (or equivalent) that runs `node --test .claude/skills/plan-execution/scripts/__tests__/`. Simple, doesn't change package layout.
- **(b) Workspace package + Turbo task.** Make `.claude/skills/plan-execution/` a workspace package with its own `package.json` exposing a `test` script; add it to `pnpm-workspace.yaml`. Inherits Turbo caching + parallel execution.

**Recommendation: (a)** for V1 — minimal blast radius, matches the skill's "not really a node package" reality. Defer (b) to a follow-on if the skill grows enough to warrant package status.

The CI step also picks up the existing `preflight.test.mjs` and `validate-review-response.test.mjs` — closing a pre-existing CI gap that the housekeeper PR series happens to also fix.

### 10.5 Optional: lefthook `.agents/tmp/` cleanup

The current `lefthook.yml` (verified 2026-05-03; jobs limited to lint-staged, gitleaks, docs-anchor-check, docs-corpus-checks, commitlint) has no `.agents/tmp/` cleanup job, **but** `.claude/skills/plan-execution/references/state-recovery.md:174` claims `.agents/tmp/` artifacts are "deleted at commit time" — a documentation/infrastructure inconsistency that predates this spec. AGENTS.md prescribes the surface-forward-then-delete pattern for transient research artifacts but does not enforce it via hook. The housekeeper writes manifests to `.agents/tmp/`; over time these accumulate.

Two paths:

- **Skip the hook for V1.** Manifests persist locally; the user manually deletes them when desired. §8.4 explicitly relies on this for post-merge manifest inspection — adding a hook would prune them before the user can inspect. CI runners build fresh worktrees so accumulation is not a CI concern.
- **Add the hook with an audit-copy escape hatch.** Lefthook job that prunes `.agents/tmp/*` on commit, EXCEPT files matching `.agents/tmp/audit/*`. The housekeeper copies its manifest to `.agents/tmp/audit/<date>-PR<N>.json` for the user to inspect post-merge.

**Recommendation: skip the hook for V1.** The audit-copy escape hatch adds complexity for a pattern that doesn't yet exist (manual `.agents/tmp/` accumulation isn't currently a problem). Revisit after Layer 4 validation concludes — if 3 PRs of inspection produce a clear "audit-copy is essential" signal, add the hook then.

## 11. Open questions

Closed during patch (no longer open):

- ~~Q11.1 NS-XX status set~~ — verified against §6 line 278: `todo / in_progress / blocked / completed`. Spec amended.
- ~~Q11.2 Multiple plans per NS~~ — superseded by §4.3 architectural decision (matcher as verification, not derivation). The script no longer derives plan/phase identity from prose; the orchestrator's §4.3 candidate-lookup uses **heading-only** matching (`Plan-NNN` + `Phase N` | `T-task-id` | `Tier K` substrings), then passes the resolved candidate(s) as `--candidate-ns NS-XX[,NS-YY]` to the script. NS-04's multi-plan heading is handled by §4.3.2 rule 2 (Plan-NNN + task-id matches either `(Plan-001, T5.4)` or `(Plan-024, T-024-2-1)`); NS-22's no-Plan-NNN heading is correctly OUT-OF-SCOPE for auto-dispatch per §4.3.4 (manual housekeeping only). The §5.5 verification table traces all 17 corpus entries through the new design as falsification evidence.
- ~~Q11.3 Mermaid style variants~~ — verified against §6 lines 285–335: `:::class` attachment is the universal pattern; `classDef` definitions are stable. Spec amended.
- ~~Q11.5 Manifest pruning timing~~ — verified `lefthook.yml` has no `.agents/tmp/` prune job; §10.5 makes the lefthook addition explicit and recommends skipping for V1.

Still open:

- **Q11.4 — Subagent prompt template location.** Inline in SKILL.md Phase E section, or a separate `references/housekeeper-prompt-template.md`? Inline is simpler but harder to snapshot-test; separate file is more testable. Default: inline + Layer 2 snapshot test pins it.
- **Q11.6 — Set-quantifier claim discovery mechanism.** The subagent must find quantifying claims like "ready set shares no files with X" / "all Y are Z" / "no W in the list does Q" affected by the merge. Options: (a) subagent greps for known quantifier phrases ("shares no", "all", "no … does", etc.) in `cross-plan-dependencies.md` + adjacent docs and re-derives each; (b) script tags suspect lines in manifest's `semantic_work_pending` for subagent attention; (c) subagent reads only §6's prose paragraphs and re-derives every quantifying sentence from scratch. **Recommended:** (c) — narrowest scope, no false-positive sweep, but caps protection at §6-resident claims (claims in other docs covered by Layer 4 only).
- **Q11.7 — Plan §Done Checklist matching algorithm.** §5.1 step 5 ticks ALL boxes in the matched Phase. Confirm this assumption holds: does any plan-execution PR ever ship a _partial_ Phase? Per orchestrator hard rule "Phase E only fires after a complete Phase merges," the answer is no — but verify against the audit-runbook's Phase definition before locking in the script behavior.

These should be resolved during the implementation plan (writing-plans skill, next step).

## 12. References

- **Source gap analysis:** `.agents/tmp/plan-execution-housekeeping-gap-analysis.md` (transient; surface-forward into implementation plan References per AGENTS.md)
- **Plan-execution skill:** `.claude/skills/plan-execution/SKILL.md`
- **Existing subagent template (mirror this shape, including `color: blue`):** `.claude/agents/plan-execution-contract-author.md`
- **Existing script template (mirror this shape):** `.claude/skills/plan-execution/scripts/preflight.mjs` + `scripts/preflight-contract.md` (to be moved to `references/`)
- **Existing test template (mirror this pattern):** `.claude/skills/plan-execution/scripts/__tests__/preflight.test.mjs` (`node:test` + `mkdtempSync`)
- **§6 NS-XX convention origin:** `docs/architecture/cross-plan-dependencies.md` §6 (introduced PR #27, merged 2026-05-02). Schema-by-example primary source: NS-01 lines 342-350, NS-04 lines 372-380, NS-12 lines 452-460, NS-22 lines 502-510 (per §1.1.1 verbatim quotes); status atomic set: line 278; mermaid block + classDefs: lines 282-336; NS-12 completion-format precedent: line 454.
- **Subagent exit-state taxonomy (the 4 canonical states; spec introduces NO new states):** `.claude/skills/plan-execution/references/failure-modes.md` § DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED.
- **Plan-execution skill v2 migration (the gap-introducing PR):** PR #28, merged 2026-05-03
- **Pre-commit infrastructure baseline:** `lefthook.yml` (verified 2026-05-03; no `.agents/tmp/` prune job present)
- **Feedback memories the housekeeper operationalizes:**
  - `feedback_set_quantifier_reverification.md` — re-derive quantifying claims when sets change
  - `feedback_canonicalization_sweep_completeness.md` — same-class sweep when relocating any referenced string
  - `feedback_verify_not_recall.md` — infrastructure beats discipline; wire as hooks
- **Recent stale-reference incidents the housekeeper would have prevented:**
  - PR #24 — 4 Codex rounds on archival-rename sweep
  - PR #27 commit `00ec528` — added NS-22 to ready set without re-checking "shares no files" claim; Codex caught the falsehood
- **Related plan-execution architecture docs:**
  - `.claude/skills/plan-execution/references/state-recovery.md`
  - `.claude/skills/plan-execution/references/failure-modes.md`
  - `.claude/skills/plan-execution/references/cite-and-blocked-on-discipline.md`

---

**Next step (per `superpowers:brainstorming` flow):** invoke `writing-plans` skill to convert this design into an executable implementation plan.
