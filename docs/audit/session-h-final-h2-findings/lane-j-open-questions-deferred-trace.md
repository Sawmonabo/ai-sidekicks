# Lane J — Open-questions / Deferred Trace

- **Lane:** J — Open-questions / deferred trace
- **Authored:** 2026-04-22
- **Subagent:** general-purpose (Lane J subagent)
- **Verification primitive:** Grep for TODO, FIXME, "deferred", "open question", "not yet", "will be", "to be determined", "TBD", "pending", "to do", "later"; check each is either tracked in a BL or carries a rationale.
- **Verdict scope:** Explicit deferral markers.

## Audit scope note

In-scope corpus per §3: `docs/architecture/`, `docs/decisions/`, `docs/specs/`, `docs/plans/`, `docs/domain/`, `docs/operations/`, `docs/backlog.md`, `README.md`. Out of scope: `docs/research/`, `docs/reference/`, `docs/archive/`, `docs/vision.md` (not in §3 list), `.claude/`, `tmp/`.

## Search patterns executed

`TODO`, `FIXME`, `deferred`, `open question` (case-insensitive), `not yet`, `will be`, `to be determined` (case-insensitive), `TBD`, `pending` (case-insensitive), `to do` (case-insensitive), `later` (case-insensitive), `unresolved` (supplemental — surfaces risk-surface deferrals).

## Pattern triage

The audit found **zero** bare TODO or FIXME markers in the in-scope corpus. All spec-level "Open Questions" sections carry inline rationale, BL cross-references, or tentative-recommendation framing ("Tentative: ..."). All "deferred" / "V1.1" / "V1.x" markers cite the governing ADR (ADR-015, ADR-017, ADR-018, ADR-010) or a specific BL (BL-047, BL-048, BL-060, BL-063, BL-084). Plan-body "Risks And Blockers" entries that use "remains unresolved" framing are declared risks carried as warnings under the Risk section — they carry the section-header rationale but a handful are bare enough to warrant flagging as MINOR-or-MAJOR for explicit-tracking discipline.

## Verdict breakdown

- MATCH: 43 sampled deferral markers (bulk of corpus)
- DRIFT: 0
- ORPHAN: 0
- MISSING: 0
- NOISE: 0
- Bare/implicit (flagged here for H3 triage): 7

Total findings enumerated below: 7 (all MINOR or MAJOR; zero CRITICAL).

## Findings

| finding-id | lane | finding-source | doc-path | line-range | claim-text | cited-source | evidence-quote | verdict | severity | severity-ambiguous | severity-rationale | verdict-rationale | remediation-status | pre-seeded | pre-seed-outcome | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SHF-J-001 | J | h2 | docs/plans/002-invite-membership-and-presence.md | 88-88 | `- Guest identity policy remains unresolved` | none | N/A | DRIFT | MINOR | true | Plan-body risk entry with no BL or rationale attached on the line itself; upstream Spec-002 §Required Behavior notes guest identity is deferred post-V1 but the Plan Risks line stands alone without a `per Spec-002` pointer or BL reference | Bare "remains unresolved" in a Risks And Blockers section; rationale only discoverable by cross-referencing Spec-002 — fails the primitive's "carries a rationale" clause at the matched line | found | false | null | Escalate to MAJOR if H3 triage treats Plan Risk entries as normative-tracking surface |
| SHF-J-002 | J | h2 | docs/plans/018-identity-and-participant-state.md | 90-90 | `- Guest or anonymous identity support remains unresolved for the first implementation` | none | N/A | DRIFT | MINOR | true | Same as SHF-J-001: Risk entry carries implicit "first implementation" rationale but no explicit BL reference or ADR pointer. The reference-design-audit `session-collaboration.md:124` explicitly flags this phrasing as "restated as a risk despite being explicitly deferred in the spec" | Plan-018 line stands alone without pointing to the governing spec or BL; rationale is implicit via "first implementation" framing but not BL-tracked | found | false | null | Complementary to SHF-J-001 |
| SHF-J-003 | J | h2 | docs/plans/008-control-plane-relay-and-session-join.md | 92-92 | `- Session-join traffic requirements for admin or recovery flows remain unresolved` | none | N/A | DRIFT | MINOR | true | Risk entry flags operational capacity concern with no BL-backed tracking; reference-design-audit `session-collaboration.md:112` confirms this is an operational sizing question that should have an owner | Bare "remain unresolved" with neither BL pointer nor inline rationale for deferral | found | false | null | Re-review for BL-filing at H3 |
| SHF-J-004 | J | h2 | docs/plans/012-approvals-permissions-and-trust-boundaries.md | 93-93 | `- Organization-level policy defaults remain unresolved for the first implementation` | none | N/A | DRIFT | MINOR | true | Same-pattern risk entry in a Risks And Blockers section; carries implicit "first implementation" rationale but no BL tracking | Plan Risk with implicit defer-to-later rationale but no tracking anchor | found | false | null | Pattern repeats across 6 plans |
| SHF-J-005 | J | h2 | docs/plans/013-live-timeline-visibility-and-reasoning-surfaces.md | 91-91 | `- Per-session verbose reasoning opt-in remains unresolved` | none | N/A | DRIFT | MINOR | true | Risk entry with neither BL reference nor "first implementation" qualifier; purely bare | Bare "remains unresolved" with no rationale at all on the matched line | found | false | null | Terser than the other instances — no implicit rationale |
| SHF-J-006 | J | h2 | docs/plans/015-persistence-recovery-and-replay.md | 90-90 | `- Snapshot compaction cadence remains unresolved and may affect rebuild performance` | none | N/A | MATCH | MINOR | false | Risk entry carries its own operational-consequence rationale ("may affect rebuild performance"); reference-design-audit `runtime-execution.md:283` confirms "Snapshot compaction cadence — explicitly deferred in Spec 015"; Spec-015 is the tracking anchor | Inline rationale plus discoverable upstream Spec-015 deferral; meets the primitive's "carries a rationale" clause | found | false | null | Logged for completeness — this one is a MATCH not DRIFT |
| SHF-J-007 | J | h2 | docs/plans/016-multi-agent-channels-and-orchestration.md | 93-93 | `- Channel-level restriction policy remains unresolved for the first implementation` | none | N/A | DRIFT | MINOR | true | Pattern-match with SHF-J-001/002/004; Spec-016 §Resolved Questions line 184 declares "V1 decision: channel-level permission restrictions are deferred" — the Plan Risk carries the deferral implicitly but does not cite Spec-016 | Bare Plan Risk; deferral rationale lives upstream in Spec-016 but is not linked from the Plan line | found | false | null | Same pattern as SHF-J-001/002/004 — H3 may triage as a single batch fix |

## Pre-seeded findings verification

Per §9.2, no Lane J items were directly pre-seeded. However, the BL-097 Resolution §7 items (pre-seeded under other lanes) were verified to carry inline rationale:

- §7(a) SQLite STRICT ADR deferral — `docs/specs/017-workflow-authoring-and-execution.md:42` verbatim: `SQLite STRICT tables adoption (criterion-gated V1.x deferral per Wave 2 §4.1 — cross-plan policy change; Plan-017 schema uses repo's existing TEXT-column convention).` Carries both Wave-2-synthesis citation and rationale. MATCH for Lane J scope.
- §7(b) Pass G §2 inherited-pragma drift — a research-file-vs-schema-file drift; research dir out of scope for Lane J. Logged as owned by Lane B/K.
- §7(c) cross-plan-dependencies §3 legend drift — owned by Lane C/D; Lane J does not audit legend shape.
- §7(d) `packages/contracts/src/` subdirectory convention — owned by Lane E/H; Lane J does not audit structural convention.

## Notable MATCHes (sampled; authoritative tracking at H3)

The following markers were verified as MATCH and are documented here for H3 triage traceability — they are NOT drift:

- **All 21 plan Done-Checklist entries** reading `- [x] Blocking open questions are resolved or explicitly deferred` (per plan template `000-plan-template.md:47`): MATCH — template-governed completion marker.
- **All 22 Bucket-A specs** with `- No blocking open questions remain for v1.` heading (001, 002, 003, 004, 005, 006, 007, 008, 009, 010, 011, 012, 013, 014, 015, 016, 017 partial, 018, 019, 020, 021, 022): MATCH — BL-075 resolved these into closed decisions.
- **Bucket-B Open Questions specs** (Spec-023, 024, 025, 026, 027): MATCH — each entry carries either "Tentative: ...", "Lean: ...", BL reference, or plan-ownership pointer (per BL-075 Resolution).
- **Spec-017 all 7 `deferred` markers** (lines 37, 38, 39, 42, 43, 82, 168, 236, 243, 382): MATCH — every marker cites ADR-015, BL-097, Wave-1/2 synthesis, SA-28, or §V1.1 Criterion-Gated Commitments.
- **Plan-017:9 "V1.1-deferred-subset at original approval"**: MATCH — cites BL-097 + ADR-015 amendment.
- **Plan-023 `Open Questions` cross-references** (lines 31, 47, 48, 49): MATCH — each points to Spec-023 §Open Questions.
- **Plan-024 lines 35, 37** (`node-pty fallback deferred`, `Runtime signature verification deferred`): MATCH — each cites ADR-019 Tripwire 3 or inline esbuild/napi-rs precedent rationale.
- **Plan-025:38** (`Grafana dashboard deferred to post-V1`): MATCH — cites Spec-025 §Open Questions.
- **Plan-026:485, 491**: MATCH — inline Spec-023 / design-track ownership rationale.
- **ADR-015 §V1.1 Features** (line 58), §Amendment History (line 234), §Decision Log: MATCH — canonical deferral registry; each V1.1 item has named criteria per `feedback_criterion_gated_deferrals` memory discipline.
- **ADR-017:108** (Option A deferred further): MATCH — carries "Depends on customer demand..." rationale.
- **ADR-018:51, 215** (central registry deferred to V1.1): MATCH — cites ADR-015 + Tripwire 2.
- **ADR-019:125, 147** (node-pty deferred): MATCH — Tripwire wording with explicit deferral-gate rationale.
- **ADR-020:106** (self-host V1.1 or later): MATCH — this is the alternative-rejected section carrying rationale.
- **ADR-021:234** ("explicitly deferred past V1 and are recorded here"): MATCH — entire section is the deferral registry.
- **Spec-002:144** ("deferred to V2" delivery mechanisms): MATCH — carries "All V2 mechanisms will use..." forward-compatibility rationale.
- **Spec-006:90** (event-type registry deferred to V1.1): MATCH — cites ADR-018 §Alternatives Considered Option C.
- **Spec-008:148** ("will be detailed in the V1.1 relay spec revision"): MATCH — MLS promotion gates in ADR-010 cited.
- **Spec-011:179, Spec-004:124, Spec-016:184, Spec-003:111, Spec-010:118, Spec-014:117** (V1 decision: X is deferred): MATCH — all carry the `V1 decision:` framing that renames §Open Questions to §Resolved Questions per BL-075.
- **Spec-015:190, 247**: MATCH — cite Spec-020 and ADR-017 as deferral targets.
- **Spec-017:41** (OpenTelemetry semconv not yet ratified): MATCH — cites [OpenTelemetry GenAI Observability Blog 2025] with accessed date 2026-04-22.
- **Spec-019:93, 128** (V2 email digest; V1 global preferences): MATCH — carry "first release" rationale.
- **Spec-024:11** ("none yet — BL-047 produced this spec"): MATCH — cites BL-047 and cross-plan-dependencies §Spec-024 V1 Gap.
- **Spec-024:241** (delegated approval V1.1 open question): MATCH — carries explicit "V1 scopes approval to target-node owner only" inline rationale.
- **Spec-025:187–191** (3 Open Questions with `Lean:` recommendations): MATCH — each carries a tentative-recommendation rationale.
- **Spec-026:36, 74, 139, 283–286**: MATCH — each cites BL-060, §Fallback, or carries "Tentative:" framing.
- **Spec-027:219–225** (5 Open Questions with plan-ownership pointers): MATCH — each names the owning plan (Plan-007, Plan-020, Plan-025) as the tracking anchor.
- **cross-plan-dependencies.md:207, 211–215** ("Spec-024 V1 Gap — Implementation Plan Pending" section): MATCH — carries BL-077 resolution-path-(a)/(b) tracking.
- **cross-plan-dependencies.md:209** ("No plans currently deferred to V1.1+ tier set"): MATCH — documents the V1.1 placeholder state explicitly.
- **cross-plan-dependencies.md:215** ("target plan number TBD — the `024` slot is taken by the Rust PTY Sidecar plan"): MATCH — inline rationale for why the TBD exists and what would resolve it.
- **data-architecture.md:132**: MATCH — cites ADR-017 for shared log V1.1 deferral.
- **security-architecture.md:270** ("will be specified in the V1.1 relay spec"): MATCH — cites V1.1 cipher suite target and implementation-selection rationale.
- **deployment-topology.md:90** ("pending root-cause fix"): MATCH — operational-response rationale inline.
- **v1-feature-scope.md:37** ("Pending audit of an MLS implementation"): MATCH — cites ADR-010 as the deferral anchor.
- **ADR-012:105** ("Ed25519 module is not yet available in the operator's compliance envelope"): MATCH — FIPS 140-3 context inline.
- **ADR-010:76** ("WebAuthn PRF extension is not yet supported"): MATCH — mitigation + fallback inline.
- **backlog.md BL-075 Resolution** naming all 22 Bucket-A + 5 Bucket-B specs: MATCH — canonical rename registry.
- **backlog.md BL-097 Resolution §7** (4 non-blocking follow-ups): MATCH (pre-seed anchor) — each carries rationale text.
- **Domain model "pending" states** (artifact-diff-and-approval-model, participant-and-membership-model, run-state-machine, session-model, workflow-model, workflow-phase-model): MATCH — these are state-machine state names, not deferral markers (false positives on grep).
- **Schema "pending" DEFAULT literals** (local-sqlite-schema.md, shared-postgres-schema.md): MATCH — SQL column DEFAULT values, not deferrals.
- **Contracts type-union "pending"** (api-payload-contracts.md): MATCH — TypeScript literal union types, not deferrals.
- **Operations runbook "later analysis"** (local-persistence-repair-and-restore.md:68): MATCH — descriptive future-tense verb, not a deferral marker.
- **Domain glossary "QueueItem"** entries: MATCH — canonical domain definition, not a deferral.

## Verdict-rationale summary for DRIFT findings

The 7 DRIFT findings (SHF-J-001 through SHF-J-005, SHF-J-007) share a pattern: Plan-body "Risks And Blockers" entries that say "remains unresolved" without an explicit BL pointer or upstream-spec citation on the matched line itself. The rationale is discoverable upstream (in the governing Spec), but the primitive's "carries a rationale" clause is weakened when the Plan line stands alone. These are MINOR because (a) the risks are pre-implementation declarations, not downstream-breaking contract claims, and (b) the pattern is consistent across the 6 Plans so H3 may choose a batch fix (add `per Spec-XXX §Resolved Questions` annotation or file a BL to track). SHF-J-006 is logged as a MATCH because its inline rationale ("may affect rebuild performance") meets the primitive's carries-a-rationale threshold independently of upstream citation.

## Blockers

None. Lane J execution completed without blocking dependencies on other lanes.

## Process notes

- Verbatim-quote-or-reject rule (§8.1) observed: all `claim-text` fields are verbatim substrings; `evidence-quote` is `N/A` per Lane J primitive (the primitive is self-contained — the claim IS the evidence, plus the check is "is there a BL or rationale in/near the claim").
- No credential/secret patterns encountered (§8.3).
- No research-dir traversal (§9.3).
- Pre-seed §9.2 items verified at paragraph level above; none required Lane J pre-seed-outcome classification (they are Lane L/B/C/E primaries).
