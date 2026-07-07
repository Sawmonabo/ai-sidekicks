# Preflight Tool Contract

The orchestrator invokes this tool at Phase 0 of plan-execution. It is the authoritative source for all mechanical gates that block dispatch.

## Invocation

    node .claude/skills/plan-execution/scripts/preflight.mjs <plan-file> [phase] [--allow-stale-manifest]

When `phase` is omitted, the tool walks the plan's Implementation Phase Sequence and resolves to the first un-shipped phase whose preconditions all pass. When provided, it validates the specified phase explicitly (used when the user override-supplies a phase number).

`--allow-stale-manifest` skips Gate 6 (manifest freshness) — the only gate with a CLI escape, because it is the only gate whose pass depends on network reachability rather than repo state. The skip is logged to stderr so a bypassed run is never silent. Programmatic callers (`runPreflight`) get the inverse default: `checkFreshness: false` unless opted in, so fixture-driven test suites stay network-free; `main()` always passes `checkFreshness: !allowStaleManifest`.

The tool MUST be run from the repo root (Gate 5 `pr_merged` and `adr_accepted` resolvers and Gate 6's freshness cross-check shell out to `gh` / read `docs/decisions/`, which expect the cwd's git remote and repo layout).

## Exit codes

- `0` — all gates pass. `stdout` contains the resolved phase number on a single line (e.g., `4`).
- `1` — a gate failed. `stdout` contains a self-contained halt message the orchestrator surfaces verbatim (failure type, file paths, remediation hint). `stderr` empty.
- `2` — internal error (malformed plan markdown, malformed YAML preconditions, missing tool deps). `stderr` describes the error; `stdout` empty. Orchestrator escalates to user; not a normal halt.

## Gates

Each gate runs in order; halt on first failure. The tool MUST NOT proceed past a failed gate (no aggregated multi-gate output).

### Gate 1 — Project-locality

Reads `requires_files:` from the skill's own frontmatter (`.claude/skills/plan-execution/SKILL.md`). Asserts `fs.existsSync` for each entry, resolved against the repo root. Failure message names the missing files and tells the user this skill is shaped for the ai-sidekicks-style repo surface.

### Gate 2 — Audit-complete checkbox (top-level lenient + per-phase strict)

Two-layer gate. The top-level `gateAuditCheckbox(planSource, planFile)` runs once before phase resolution and passes when EITHER (a) the plan body has the ticked `^- \[x\] \*\*Plan-readiness audit complete` row OR (b) any phase in the plan declares a `type: audit_status` precondition entry (the substrate-vs-namespace carve-out path). The strict per-phase enforcement runs inside `_checkPhase` via `gatePhaseAuditCheckbox(planSource, phaseSection, planFile, phaseNumber)`, which requires the resolved target phase specifically to carry either the plan-level checkbox OR its own `type: audit_status` declaration.

The two-layer split exists because plans like Plan-023 ship Tier 1 phases under substrate carve-outs while Tier 8 remainder phases haven't been authored. A purely plan-scoped check would force every yet-to-be-authored phase to carry the YAML up-front; a purely lenient check would let those un-authored phases dispatch through the carve-out path. The lenient top-level + strict per-phase combination is what admits Plan-023 Phase 1 today without preauthorizing future Phase 2+ dispatches.

Failure references the audit runbook path, the Status Promotion Gate concept, and the runbook §Per-Phase Audit Semantics section.

### Gate 3 — Phase un-shipped

Reads the plan file in two passes:

1. **Declared tasks.** Extract the phase's `#### Tasks` block via `extractDeclaredTaskIds(phaseSection)`. Both audit-Tasks-block layouts are accepted: sub-header form (`##### T1.1 — title` — Plan-001 style) and bullet+bold inline form (`- **T-007p-1-1** (Files: …) — …` — Plan-007 partial style). Returns a sorted unique array of task ids.
2. **Shipped tasks for this phase.** Extract via `parseManifestBlock(planSource)` from `lib/manifest.mjs`, then `shippedTaskIdsForPhase(manifest, phaseNumber)` which collects entries where `entry.phase === phaseNumber`, flattens the `task` field across both string and array forms (legacy multi-task PRs predate NS-02), and returns a `Set`.

Halt if `declared ⊆ shipped` — every declared task for the phase appears in the manifest. NS-02 partial ships (e.g., Plan-001 Phase 5 Lane A T5.1 alone, with T5.5/T5.6 still declared and un-shipped) leave the gate open. Phases whose tasks block contains zero ids fall through to Gate 4 (the audit's G4 traceability gate catches missing Tasks-block content).

When phase is auto-selected, the tool just skips already-shipped phases; the explicit halt message fires only on explicit-phase overrides for already-shipped phases.

**Why manifest set-comparison, not gh search.** The pre-Commit-3 mechanism inferred shipment from PR title/body via `gh pr list --search "Plan-NNN in:title,body"` plus three regex matchers (`Plan-NNN PR #N`, `Plan-NNN Phase N`, phase-title substring) and a code-prefix filter. The history is documented in [BL-110](../../../../docs/archive/backlog-archive.md) and the Plan-001 shipment-manifest refactor: PR-body conventions vary across plans (Plan-001 uses `Plan-NNN PR #N`, Plan-007 partial uses `T-NNNp-N-N`, post-NS-02 uses task ids in titles), every regex pattern bought one false-match class while introducing another, and the 1000-PR fetch ceiling forced a sentinel halt. The structured manifest moves shipment state out of free-form prose and into a `### Shipment Manifest` YAML block per plan; Gate 3 becomes a set-comparison against an explicit data structure. Less code (~30 lines vs ~145), no network call, no fetch ceiling, and the partial-ship class (NS-02 lane carve-outs) falls out of the set-comparison naturally rather than requiring an asymmetric-pattern-reach hack.

**Strict halt on parse failure.** Gate 3 halts (exit 1) when `parseManifestBlock` returns `!ok` — including the `no_section` case (no `### Shipment Manifest` heading), `no_yaml_fence` (heading exists but the ```yaml fenced block is missing or truncated), `missing_schema_version`(fence parsed but the top-level`manifest_schema_version`key is absent), and`missing_shipped`(schema-version present but the`shipped:`top-level key is absent — plan author must add`shipped: []`for an empty manifest or list entries under it). Pre-round-7 the gate fail-opened on parse failure; in auto-walk mode this could re-dispatch already-shipped phases after any manifest formatting error (Codex P1 finding on PR #35 round 7). The`missing_shipped`case was added in round 10: pre-round-10 the parser returned`{ ok: true, version, shipped: [] }`when only the version line was present, which silently zeroed out the shipped-tasks set and re-opened Gate 3 for already-shipped phases (Codex P1 finding on PR #35 round 10). Plans created before Commit 1's template change must add the`### Shipment Manifest`section per`docs/plans/000-plan-template.md` before preflight resolves them.

**Strict halt on entry-schema failure.** Even when the YAML structure parses, every `shipped[]` entry runs through `validateEntry` from `lib/manifest.mjs`. Type or shape errors (e.g. `phase: "5"` as a string instead of an integer, missing `task`, unknown field names) trigger the `manifest_invalid_entries` classifier kind and halt with a per-entry error list. Pre-round-8 the classifier read entry fields directly without schema validation, so type-mismatched entries silently produced an incomplete shipped-tasks set and re-opened Gate 3 for already-shipped phases (Codex P2 finding on PR #35 round 8).

**Auto-walk surfaces strict halts.** `_checkPhase` propagates the classifier kind on every Gate 3 failure (`reason: ship.kind`), and the auto-walk loop in `runPreflight` only silent-skips `reason: "fully_shipped"`. Both `manifest_unparseable` and `manifest_invalid_entries` short-circuit the loop with `{ exit: 1, stdout: r.halt }`, so the strict halts above fire in auto-walk mode the same way they fire in explicit-phase mode. Pre-round-9 `_checkPhase` collapsed every failure to `reason: "shipped"`, so the loop silenced manifest corruption and emitted "no eligible un-shipped phase" with the halt buried in the per-phase `skipped[]` text (Codex P1 finding on PR #35 round 9). The explicit allow-list — not a default — guarantees future strict-halt classifications also surface unless they are explicitly added as silent-skip.

**Schema-version forward compat (only intentional fail-open).** `parseManifestBlock` returns `{ ok: true, version, shipped }` for any version >= 1. Gate 3 treats unknown future versions (`manifest.version > MANIFEST_SCHEMA_VERSION`) as opaque — fail open, do not block dispatch on a partial migration. The policy lives in `lib/manifest.mjs`'s header. This is the only case where Gate 3 silently passes; every other parse outcome (failure or full-shipped) halts loudly.

**Why phase-walk, not title-count.** Plans with substrate/namespace or partial/remainder carve-outs ship phases non-contiguously across tiers. Plan-007 ships Phases 1-3 in Tier 1 (substrate partial carve-out) and Phases 4+ in Tier 4 (remainder). Counting merged `Plan-007` PRs after the third merge returns next M=4, which silently maps to Tier-4 work whose preconditions (Plan-001 + others) may not be met. The phase-walk gates each phase on its declared Precondition (Gate 5), so the auto-selected phase is always the lowest-numbered phase whose preconditions all pass — substrate-carved or otherwise.

### Gate 4 — Tasks-block G4 cites

Extracts the selected phase's section (between `### Phase N —` and the next `### Phase` header). Counts `Spec coverage` and `Verifies invariant` substring matches. Each must be ≥ 1. Failure means the audit's G4 traceability gate did not produce content; user must re-run the audit.

The token-presence floor above ran alone until 2026-05-21, when post-mortem `51ca5f3d` revealed it false-greened on seven distinct cite-anchor defect classes that the audit subagent prompt did not operationalize against (DP-1 in the post-mortem; PR #95's nine latent defects on `develop` @ `7d3abb3`). Gate 4 now also runs a **semantic anchor check** that parses each `**Spec coverage:**` and `**Verifies invariant:**` payload, verifies each anchor exists in the cited spec, and surfaces structured failures. The two-layer split exists so audit-output that lacks G4 content (the original false-negative) and audit-output whose G4 content is semantically incorrect (the post-mortem defect class) both halt — neither subsumes the other.

#### Semantic anchor check — parser grammar

Per-payload parsing runs as `extractCiteAnchors(phaseSection)` → `parseCitePayload(rawPayload)` → `parseSegment(seg)`. Tokenization is paren-aware (commas, semicolons, and `+` inside `(...)` are not anchor separators) and dash-normalized (`–` U+2013 and `—` U+2014 fold to ASCII `-`) BEFORE pattern-match — without normalization the load-bearing en-dash compound-range defect (post-mortem class 2) is silently missed.

Top-level segment boundaries (depth-0): `;` is canonical (cross-namespace, e.g. `Spec-001 AC8; ADR-018 §Decision #4`); `,` is also a segment boundary when followed by another recognized namespace prefix (`Spec-NNN`, `ADR-NNN`, `<doc>.md`, `cross-plan-deps`). The latter shape (`Spec-002 AC1 (line 178), Spec-002 line 87 + AC1 (I3)`) appears in approved plans (Plan-002 T5.1/T5.3) to disambiguate `(line N + AC M)` sub-anchor groups. A comma followed by a sub-anchor keyword (`AC`, `line`, `lines`, `§`) stays inside the current namespace.

Accepted shapes (each emits one or more anchors with `severity: info|warn`; `severity: error` is rejection-only):

- `Spec-NNN AC-X` — single bare AC. `severity: info` (line-hint recommended).
- `Spec-NNN AC-X (line YY[ — Subject])` — AC with explicit line + optional identifier-token subject.
- `Spec-NNN AC-X (descriptor)` — AC with prose descriptor (no identifier-token subject). `severity: info`.
- `Spec-NNN line YY[ (Subject)]` — line with optional descriptor.
- `Spec-NNN §Section line YY[, line ZZ[, line WW]][ (descriptor)]` — comma-separated multi-line under one §Section. Splits into N anchors.
- `Spec-NNN §Section line YY[ (Subject)]` — single §Section + line + optional descriptor.
- `Spec-NNN line YY + AC-X[ (Subject)]` — `+`-combined line + AC. Splits into two anchors.
- `Spec-NNN §A line YY, §B line ZZ` — comma-separated re-section sub-anchors. Each `§<Section> line N` token inside a single `Spec-NNN` namespace switches the active section and emits one line anchor.
- `Spec-NNN §Section` (no line) — bare §-cite. `severity: warn` (line-anchor recommended; non-blocking by design).
- `Spec-NNN lines YY-ZZ (single-subject descriptor)` — multi-line block with one identifier-token subject in descriptor (e.g., `RateLimitResponse lines 127-133`). One anchor.
- `ADR-NNN §Section[ (row|item) M[ (descriptor)]]` — ADR-namespaced anchor. Parser verifies ADR file glob; section verification is documentary not mechanical.
- `<doc>.md[ §Section][ (descriptor)]` — architecture-doc cite (e.g., `error-contracts.md`, `cross-plan-deps`). `severity: warn` if §Section absent.
- `cross-plan-deps §N[ row M][ + §K row M][ (descriptor)]` — cross-plan-deps multi-row form.
- Literal `none[ (descriptor)]` — forward-compat scaffold or no-spec rationale. `severity: info`.
- Bare Plan-local IDs (`Cn` / `Pn` / `Pr-n` / `In` / `I-NNN-N` and ranges `I-NNN-N..M`) outside any `Spec-NNN` namespace prefix. Pattern: `^(?:C|P|Pr|I)-?\d+(?:\.\.\d+)?(?:-\d+(?:\.\.\d+)?)*$`. `severity: warn` in `**Spec coverage:**`; canonical (no warn) in `**Verifies invariant:**`.

Rejected shapes (each emits one failure with `severity: error`; **blocks Gate 4**):

- **`compound-range-multi-subject`** — `Spec-NNN lines YY-ZZ (...)` where the descriptor names ≥ 2 distinct identifier-token subjects (e.g., `PresenceUpdate/PresenceRead`). One-anchor-per-behavior rule. Defense-in-depth: a payload-level scan runs after per-segment parsing and re-fires this rule when the surrounding shape (multi-§Section, mixed-namespace continuation) prevented `parseSpecSegment` from reaching the range branch.
- **`namespace-violation`** — `Plan-NNN:LLL` (colon-line-number) inside any `Spec-NNN ... (... Plan-NNN:LLL ...)` parenthetical. Plan-NNN line cites do not belong in `**Spec coverage:**`. Discriminator: `Plan-NNN §Section` (no colon-line-number) inside the same parenthetical is accepted as legitimate cross-plan context.
- **`plan-local-id-as-spec-anchor`** — `Spec-NNN <PlanLocalID>` (e.g., `Spec-002 C5`) at first anchor position. Plan-local row IDs are not Spec-NNN anchors. Discriminator: `<PlanLocalID> (Spec-NNN line YY — descriptor)` (Plan-local-ID outside Spec namespace prefix) is accepted.
- **`phantom-section`** — `Spec-NNN §<section>` where the section heading does not exist in `docs/specs/NNN-*.md` (case-insensitive substring match against `^#{1,6}\s+<section>\s*$`).
- **`spec-file-not-found`** — `Spec-NNN ...` where `docs/specs/NNN-*.md` glob has zero matches or multiple matches.
- **`out-of-range-line`** — `Spec-NNN line YY` where YY is blank or past EOF.
- **`subject-mismatch`** — `Spec-NNN line YY (Subject)` where the identifier-token `Subject` does not appear on line YY of the spec (tolerant of separator variants: `PresenceHeartbeat` ↔ `presence.heartbeat` ↔ `presenceHeartbeat`).

`unparseable-spec-subanchor` (Spec-NNN sub-token that didn't match any sub-shape), `unparseable-cite` (top-level token that matched no namespace pattern), and `plan-local-id-malformed-trailer` (plan-local-id segment with a leading `,` / `;` / `+` trailer, e.g. `I-024-3, typo`) all emit at `severity: error` and block the gate — they close false-green paths Codex flagged on PR #96: a malformed sub-anchor used to silently warn-pass, a top-level token like `xyz junk` used to silently warn-pass despite §Pre-3 implication 6 mandating error reporting, and a comma-separated plan-local-id list (`I-024-1, I-024-2`) used to swallow the trailing IDs into the first anchor's descriptor. The top-level splitter now also recognizes `, Cn`/`, Pn`/`, Pr-n`/`, In`/`, I-NNN-N`/`, none` as segment boundaries so multi-id payloads split cleanly. Namespace-recognized but shape-malformed cites (`adr-unparseable`, `arch-doc-unparseable`, `cross-plan-deps-unparseable`, `plan-local-id-unparseable`) stay at `severity: warn` to fail-open on unknown shape variants the parser doesn't yet recognize.

#### Semantic anchor check — verifier rules

Each emitted anchor is verified by `verifyAnchorAgainstSpec(anchor, repoRoot)`:

- `type: line` — locate the spec file via `findPaddedFiles(specsDir, anchor.spec)`. Fail with `spec-file-not-found` if no match, or `spec-file-ambiguous` if multiple files share the same numeric prefix. Then read line `anchor.line`; fail with `out-of-range-line` if blank or past EOF. If `subject` present, lowercase + strip-punctuation both sides and verify subject tokens appear on the cited line. Fail with `subject-mismatch` if not.
- `type: line-range` — verify `[anchor.start, anchor.end]` lies within file bounds and `anchor.start <= anchor.end`; fail with `line-range-out-of-bounds` otherwise. If `anchor.subject` present, search the cited range _plus ±2 ambient lines_ (clamped to `[1, specLines.length]`) for the normalized subject token; fail with `subject-mismatch-in-range` if absent. The ambient window exists because Spec contracts commonly name the identifier on a prose intro line immediately above (or below) a fenced shape block — e.g., Spec-002 §Rate Limiting line 125 sits above the canonical-shape code block at lines 127-133. Citing only the shape was previously over-rejected, forcing authors to widen the range artificially; the ±2 bound preserves intent (cite the shape) while accepting one-line introductions on either side.
- `type: ac` — find `^## Acceptance Criteria` heading; count `^- \[[ x]\]` bullets in the section; assert the X-th exists. If `lineHint` present, assert that line is the N-th AC bullet specifically (fail with `ac-line-hint-wrong-bullet` when the hint lands on a different AC index, `ac-line-hint-outside-section` when outside §AC, `ac-line-hint-not-bullet` when not a checkbox row).
- `type: section` — verify named section heading exists in the spec. Matching is exact-after-normalize (lowercased + non-alphanumeric stripped); partial heading prefixes like `§Token` against `Token Security Properties` fail with `section-not-found`.
- `type: adr-section` — file-existence check against `docs/decisions/NNN-*.md` (via `findPaddedFiles`). Fail with `adr-file-not-found` if no match, or `adr-file-ambiguous` if multiple files share the same numeric prefix. Section + item/row are not mechanically verified (they are documentary).
- `type: arch-doc` — file-existence check against `docs/architecture/**/<filename>` (recursive via `findArchDocFiles`, handling the `contracts/` and `schemas/` subdirs). Fail with `arch-doc-not-found` if no match, or `arch-doc-ambiguous` if the filename collides across subdirs. Section is documentary.
- `type: cross-plan-deps` — file-existence check against `docs/architecture/cross-plan-dependencies.md`. Fail with `cross-plan-deps-file-not-found` if missing. Section + row are documentary.
- `type: none-literal` / `type: plan-local-id` — trivial pass (no external doc to verify). Reason: `no-external-doc-to-verify`.

The existence checks above are gated by orchestrator-supplied paths (`adrsDir`, `archDocsDir`, `crossPlanDepsFile` in `verifyAnchorAgainstSpec` opts). When a path is omitted (e.g. unit tests that only exercise Spec verification) the verifier returns `valid: true, reason: <namespace>-dir-unconfigured` — anchors pass instead of false-failing the test. `gateTasksBlockCites` resolves all paths from `repoRoot` so production runs always exercise existence checks.

#### Gate 4 aggregation

`gateTasksBlockCites(phaseSection, planNumber, phaseNumber)` collects (a) the token-presence floor result and (b) the semantic-anchor failures across every cite in the phase. The gate halts when any failure has `severity: error`; `severity: warn` failures surface in the report but do not block. The halt message lists each blocking failure with `[kind] T-N.M (field): message` + `cite: <raw>` + `fix: <remediation>`, and cross-links the authoring contract (`docs/operations/plan-implementation-readiness-audit-runbook.md` §Subagent Prompt Template) and this verifier contract.

#### Why error vs warn

The seven rejection classes above correspond 1:1 to defect classes the post-mortem named — each one shipped a load-bearing semantic regression to `develop` that Codex would have caught had Phases 3-6 reached non-draft review. Treating them as `error` is the verification-side half of the root-cause fix; the authoring-side half is the four mechanism clauses in the runbook §Subagent Prompt Template (per-anchor verify / one-per-behavior / Plan-vs-Spec namespace / return-DONE self-verify). `warn`-level findings (bare §-cites, bare ACs, unknown-shape long tail) surface for human review without forcing a re-audit on every plan that pre-dates the new contract — the gate is additive, not retroactively destructive.

#### Cross-link

The cite-amendment subagent template (`docs/operations/plan-implementation-readiness-audit-runbook.md` §Cite-Amendment Subagent Prompt Template) names Gate 4 as its orchestrator-side verifier: subagent self-verification is authoring discipline; Gate 4 is enforcement. Both layers must be present — neither alone closes the post-mortem root cause.

### Gate 5 — Phase preconditions

Parses the phase's `preconditions:` YAML block (see plan template § Implementation Phase Sequence). For each entry:

- `{type: pr_merged, ref: <N>}` → `gh pr view <N> --json state` returns `MERGED`.
- `{type: adr_accepted, ref: <NNN>}` → `docs/decisions/<NNN>-*.md` Status field equals `accepted`.
- `{type: plan_phase, plan: <NNN>, phase: <N>, status: merged}` → that plan's `### Shipment Manifest` block fully ships every declared task for Phase `<N>` (declared ⊆ shipped, the same set-comparison Gate 3 runs on the local plan). Pre-round-7 the resolver matched any phase entry (`some(e.phase === entry.phase)`); after manifest entries became task-level under NS-02, that became a partial-ship false-positive — Plan-001's T5.1 entry would unblock a downstream Plan-001 Phase 5 dependency even though T5.5/T5.6 were unshipped (Codex P2 finding on PR #35 round 7). Halt outcomes: `partially_shipped` (lists missing tasks), `manifest_unparseable` (mirrors Gate 3's strict halt on parse failure), `no_phase_section` (upstream plan lacks the requested phase). Fail-open outcomes: `fully_shipped` (precondition satisfied), `manifest_future_schema` (mirrors Gate 3's schema-version-future fail-open), `no_declared_tasks` with a phase-presence match (legacy fallback for plans whose `#### Tasks` block lacks task ids — phase-presence in the manifest is treated as evidence of completion). (Pre-Commit-6 the resolver matched on `## Progress Log` prose for `Phase N` or `PR #N` substrings; the new mechanism reads the structured manifest the same way Gate 3 does.)
- `{type: cross_plan_carve_out, ref: <id>}` → entry exists in `docs/architecture/cross-plan-dependencies.md` §5. The membership check is scoped to §5 only via the shared `extractSection5` helper — pre-fix it used `source.includes(ref)` over the whole file, which passed when the ref appeared in §3 prose or §6 NS-rows even when §5 had no entry. Tool only verifies §5 presence, not semantic correctness; the substantive shape check (substrate-vs-namespace structure) is covered by the `audit_status: substrate_exempt` criterion (3) below.
- `{type: audit_status, status: complete, evidence_pr: <PR#>, baseline_tag: <git tag>}` → the act of declaring `complete` is the load-bearing assertion (matches the existing Gate 2 behavior of trusting the human-set checkbox). `evidence_pr` + `baseline_tag` are documentary; preflight does not mechanically verify them — see runbook §Per-Phase Audit Semantics.
- `{type: audit_status, status: substrate_exempt, carve_out_ref: <§5-heading-text>}` → three criteria. (1)+(2) human-judged at audit time per Plan-007 §Execution Windows. (3) is mechanically verified: (a) `carve_out_ref` MUST appear inside §5 of cross-plan-dependencies.md via the shared `extractSection5` helper; (b) phase body MUST contain one of the canonical empty-coverage sentinels (`covers no Spec-NNN acceptance criteria`, `covers NO Spec-NNN AC`, `substrate is pre-behavior plumbing`); (c) the `#### Tasks` block MUST NOT cite Spec coverage in bracket-form (`Spec coverage: [Spec-NNN row M]`) — prose-form mentions are tolerated because they describe coverage absence. A phase that declares `substrate_exempt` ALSO causes Gate 4 (Tasks-block G4 cites) to be skipped — by criterion (3) the phase ships zero Spec AC, so Gate 4's "Spec coverage" substring requirement would halt it by design.
- `{type: bl_closed, ref: <N>}` → backlog item `BL-<N>` (the `ref` is zero-padded to three digits) has Status `completed`. The resolver reads `docs/backlog.md` first via the shared `extractBacklogItemSection` helper; when the item is absent from the active backlog — the normal post-resolution state, since closed items are swept to `docs/archive/backlog-archive.md` per the CLAUDE.md backlog discipline — it falls through to the archive. In **both** locations the Status line is re-parsed by `judgeBacklogCompletion` and must read `completed`: archive presence is never trusted on its own, because the archive also holds `withdrawn`/`superseded` items that did not land (BL-136 is the canonical `withdrawn` example). Halt outcomes: any open state (`todo`/`in_progress`/`blocked`), a non-`completed` archived state, an unparseable Status line, or a `BL-<N>` found in neither file (mint the item or correct the ref). Introduced for Plan-003 Phase 3 (NS-32), which gates on the Spec-003 §Default-Behavior heartbeat-threshold amendment — a governance change whose PR number is unknowable at declaration time and whose value is a spec default, not ADR-worthy, so neither `pr_merged` nor `adr_accepted` can express the dependency (Codex P2 on PR #138).

If the phase has no `preconditions:` YAML block (legacy plan), fall back to regex parsing of the prose `**Precondition:**` line. Four patterns are recognized (all case-insensitive):

- `PR #N merged` → `{type: pr_merged, ref: N}`
- `ADR-NNN accepted` → `{type: adr_accepted, ref: NNN}`
- `Plan-NNN Phase K merged` → `{type: plan_phase, plan: NNN, phase: K, status: merged}`
- `Phase K merged` (bare, no `Plan-NNN` prefix) → `{type: plan_phase, plan: <local plan>, phase: K, status: merged}`. The bare form resolves to the plan the precondition lives in — corpus convention across Plan-001/003/007/024. The bare-form regex carries a negative lookbehind `(?<!Plan-\d{3}\s+)` that excludes the segment inside an already-matched `Plan-NNN Phase K merged`, so providing the explicit-prefix form does not produce a duplicate entry against the local plan.

The `audit_status`, `cross_plan_carve_out`, and `bl_closed` types are YAML-only — they have no prose-line analog. Prose preconditions that interpolate link-text or other tokens between `Phase K` and `merged` (`[Plan-NNN Tier K Partial](...) merged`, `Plan-001 Phase 5 CP-001-2 cwd-translator merged`) are NOT matched by either regex; the line emits zero entries and `gatePreconditions` silently passes (legacy free-form tolerance). Express such cross-plan carve-out dependencies as a YAML `cross_plan_carve_out` + `pr_merged` pair to put them on the machine-enforced path (Plan-002 Phase 2's Plan-025 Tier 1 Partial dependency is the canonical example). Both schema and regex failures escalate to exit code 2 if the precondition is wholly unparseable.

### Gate 6 — Manifest freshness (plan-level; executed before the phase walk)

Cross-checks the plan's `### Shipment Manifest` against merged PRs whose **title** cites the plan, and halts when a merged material PR has no manifest entry. Numbered 6 by accretion order (Gates 1-5 keep their historical numbers), but EXECUTED between Gate 2 and the per-phase walk: Gate 3 and Gate 5's `plan_phase` resolver both treat the manifest as authoritative, so a stale manifest corrupts phase selection — a merged-but-unrecorded shipment re-opens an already-shipped phase and re-dispatches completed work. That silent-drift class is exactly what [BL-110](../../../../docs/archive/backlog-archive.md) tracked: the post-merge housekeeper is the sole manifest writer, and any run that dies between merge and housekeeping (or any follow-up PR shipped outside a plan-execution run) leaves the manifest silently stale.

**This is not a return to the gh-search shipment inference Gate 3 removed** (§Gate 3 "Why manifest set-comparison, not gh search"). The manifest remains the sole authority for phase selection; gh is consulted only to cross-check manifest **completeness** — ground truth stays git, the manifest is a cache. Three deliberate narrowings keep the old false-match classes out:

1. **`in:title` only, never `in:title,body`.** PR bodies cite plans in passing constantly (the 2026-07-06 baseline sweep measured 80 body-matches for Plan-001 alone); titles cite the plan they ship for. The empirical sweep found title-search precision exact across all 27 plans. Recall is the traded cost: a shipment PR whose title omits the `Plan-NNN` token is invisible to this gate — which is why the Phase 0.3 scaffold makes the token mandatory in PR titles. That same recall trade is the enhancement-lane boundary: lane-2/3 PRs (CONTRIBUTING.md §How Code Lands) deliberately omit the token and are invisible to this gate by design.
2. **Material-path filter.** Only candidates whose diff touches a material path — `packages/`, `apps/`, or `.github/` (`MATERIAL_PATH_PREFIXES`) — count as shipments (`gh pr view N --json files,changedFiles` per candidate). `packages/` + `apps/` are the ownership map's code families; `.github/` is included because Plan-024 Phase 4 ships workflow-only tasks whose sole file is `.github/workflows/sidecar-build.yml` (T-024-4-1; Codex P2 on PR #182). The inverted form (material = anything outside `docs/`) was rejected on corpus evidence: governance PRs whose titles cite plans also ship root files — PR #1 touches `.gitignore` / `README.md` / `AGENTS.md` under a Plan-001 title — so exclude-docs would permanently false-halt Plan-001. Root-config-only shipments remain outside the predicate; no plan in the ownership map ships root files alone, and the filter should be revisited if one appears.
3. **Halt-with-remediation, never auto-derive.** A missing entry halts and names `rebuild-shipment-manifest.mjs --plan NNN --dry-run` as the reconciliation path. The gate never writes manifest entries itself: rebuild's operator-confirmation model owns phase/task attribution ambiguity, and BL-110's option-(b) self-healing was deliberately adapted to fail-closed-with-remediation for that reason.

Outcome table:

- Manifest unparseable → **pass** (`deferred_to_gate3` — Gate 3 owns the structural halt with richer remediation; running the cross-check on an unparseable manifest would double-report).
- Manifest schema-version future → **pass** (mirrors Gate 3's only intentional fail-open).
- All merged in-title material PRs present in `shipped[].pr` → **pass**.
- Missing material PR(s) → **halt** listing each PR (number, merge date, material-file count, title) + the rebuild remediation + the escape flag.
- gh unreachable / malformed output → **halt** (fail closed per the ADR-023 gate-vs-detector discipline: gates fail closed, detectors warn; a manifest that cannot be cross-checked is treated as potentially stale, not silently trusted).
- `gh pr list` returns exactly `FRESHNESS_FETCH_LIMIT` rows → **halt** (possible truncation; mirrors rebuild's exit-6 saturation sentinel).
- Per-PR file list truncated (`files.length < changedFiles`, the GraphQL `files(first: 100)` ceiling) → **halt** (mirrors rebuild's exit-7 discipline; an unclassifiable candidate cannot be assumed doc-only).

## Stability

This tool is the single point of mechanical-gate truth. New gates land here, not in SKILL.md prose. The contract above is versioned by git history; no version stamp in the file.
