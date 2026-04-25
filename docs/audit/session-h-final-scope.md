# Session H-final: Comprehensive Drift Audit — Scope Lock

**Status:** H1 scope-lock artifact (active)
**Session:** H-final
**Authored:** 2026-04-22
**Supersedes:** N/A (first comprehensive drift audit)
**Dispatch gate:** H2 subagent fleet dispatch requires explicit user "go" after this doc is reviewed and approved.

---

## 1. Purpose and Mandate

Session H-final is the canonical drift audit that establishes the baseline state of the AI Sidekicks documentation corpus before Plan-001 code execution begins. The audit's mandate is exhaustive drift detection across three dimensions — external-source fidelity, internal cross-reference integrity, and internal content consistency — followed by remediation and a permanent audit ledger.

The audit is *discovery-then-remediate*: H2–H3 produce findings only, H4 freezes the discovery boundary, H5–H6 remediate, H7–H8 review and close. Findings are classified by a fixed 12-lane taxonomy (§5) and triaged against a fixed severity rubric (§6). Subagent output is constrained by a verbatim-quote-or-reject contract (§8) to prevent hallucinated findings.

The completion bar (§13) is: a fresh Opus 4.7 session, given only the approved post-H-final doc corpus and no conversational context, can begin Plan-001 code execution without blocking on doc clarification.

---

## 2. Eight-Phase Overview

| Phase | Name | Output | Gate |
| --- | --- | --- | --- |
| **H1** | Scope lock + pre-audit inventory | This document | User approval |
| **H2** | Parallel subagent audit dispatch (12 lanes) | Raw findings per lane, one file per lane under `docs/audit/session-h-final-h2-findings/` | None (subagents run in parallel) |
| **H3** | Findings consolidation + triage | Unified findings ledger with verdicts + severities | **Advisor gate** (independent review of triage) |
| **H4** | Frozen-discovery checkpoint | Scope-freeze statement; no new drift classes added | Meta-drift prevention; no gate |
| **H5** | Remediation plan | Per-finding edit plan with before/after text | User approval |
| **H6** | Remediation execution | Edits land; ledger updated with commit SHAs and text hashes | **Pre-H6 rollback tag** `pre-session-h-final-remediation` created |
| **H7** | Remediation review | Post-remediation advisor review; regression/hallucination check | **Advisor gate** |
| **H8** | Commit + close | LICENSE commit (1/2) + audit commit (2/2); Session H-final closed | User approval |

The frozen-discovery rule at H4 prevents meta-drift: once H3 triage closes, no new drift *classes* may be added to the audit. New instances found during H6 remediation are logged in the ledger with `finding-source: remediation-time` (see §7 schema) but do not expand the 12-lane taxonomy.

---

## 3. In-Scope Corpus

The audit covers all files under:

- `docs/architecture/` (incl. `schemas/`)
- `docs/decisions/` (all ADRs)
- `docs/specs/` (all specs)
- `docs/plans/` (all plans)
- `docs/domain/`
- `docs/operations/`
- `docs/backlog.md`
- `docs/cross-cutting/` (if present)
- `README.md`
- Any other `.md` file at repo root (e.g., `LICENSE.md` if present; see §10.3 for LICENSE handling)

Additionally audited for existence-only (not content):

- `assets/hero/*.html` mock HTML fragments — audited only for references from ADRs/specs. Content is frozen by the BL-096 Option A decision (Session K) and out of scope for content drift.

---

## 4. Out-of-Scope Exclusions

Explicitly excluded from H2 subagent scope:

- **`docs/research/`** — research passes are frozen-in-time snapshots per the research-standards discipline. They are the *source* for downstream citations, not audit targets. Drift between research and downstream docs is caught by lane A/B/I, not by auditing research files themselves.
- **`.claude/`** — session configuration, not product documentation.
- **Source code** — no source code exists yet (Plan-001 has not executed). If any code surfaces during audit, it is out of scope for this audit.
- **Git history** — the audit audits the current tree state, not historical commits. `git log` is reference-only.
- **Mock HTML content** — see §3 above.

---

## 5. Twelve-Lane Drift Taxonomy

Each lane has a single verification primitive. A lane's verdict for a given claim is one of:

- **MATCH** — claim verified against the primitive
- **DRIFT** — claim contradicted by the primitive
- **ORPHAN** — claim references a target that does not exist
- **MISSING** — claim is expected but absent
- **NOISE** — primitive inconclusive (e.g., external URL temporarily unreachable); re-run required

| Lane | Name | Verification Primitive | Verdict Scope |
| --- | --- | --- | --- |
| **A** | External citation existence | Fetch cited URL; check page returns 2xx; check cited version/page/section exists in page DOM | URLs, version numbers, page/section anchors in external sources |
| **B** | External citation quote fidelity | For each `>` quoted block or inline-quoted claim citing an external source: fetch source, verify verbatim substring match | Quoted text claiming `([source])` attribution |
| **C** | Internal cross-reference validity | For each `./...` or `../...` markdown link: resolve relative path from source file; check target file exists | All intra-repo markdown links |
| **D** | Internal cross-reference bidirectionality | For each "per X" / "see X" / "X specifies Y" claim referencing another doc: check target doc carries the claim | Normative cross-references between specs/ADRs/plans |
| **E** | Coverage/orphan detection | For each Spec: check a Plan exists. For each Plan: check a Spec exists. For each BL: check Exit Criteria → closing artifact chain | Spec↔Plan pairs; BL Exit Criteria fulfillment |
| **F** | Version/date consistency | Parse all `Updated:`, `Amended:`, `Authored:`, `Resolved:` timestamps and amendment dates; check chronological validity and intra-doc consistency | Timestamps, "as of" markers, amendment dates |
| **G** | Feature-scope count consistency | Extract V1/V1.1/V2 counts from ADR-015, v1-feature-scope.md, ADR-020, any other scope-enumerating doc; check equality | V1 = 17, V1.1 = 3 post-BL-097 |
| **H** | Dependency/topology trace | Parse `cross-plan-dependencies.md` §3 and §5; for each Plan: check claimed dependencies + tier placement + shared-resource claims match target plans' headers | Plan dependency graph; tier assignments; shared-resource declarations |
| **I** | Resolution/backlog trace | For each BL with Status=completed: check Resolution block cites the landing commit/session; check every Exit Criterion has ✅ with evidence | BL Resolutions, Exit Criteria fulfillment evidence |
| **J** | Open-questions / deferred trace | Grep for TODO, FIXME, "deferred", "open question", "not yet"; check each is either tracked in a BL or carries a rationale | Explicit deferral markers |
| **K** | Numeric consistency (sub-lane) | Extract all numeric claims (capacity, thresholds, ratios, limits); cross-tabulate by subject; check agreement | Capacity targets, rate limits, memory budgets, connection counts, rps figures, ratios |
| **L** | ADR status consistency (sub-lane) | For each ADR: parse header status field; check Amendment History + Decision Log entries align; check downstream docs cite correct status | ADR lifecycle status (active/superseded/amended), amendment chains |

**Lane orthogonality invariant:** a given drift instance SHOULD belong to exactly one lane. If a finding sits in two lanes, H3 triage resolves ownership; the ledger records both lane-IDs and picks one as authoritative for remediation tracking.

**Lane independence:** no lane consumes another lane's output. All 12 dispatch in parallel.

---

## 6. Severity Rubric

Every finding carries exactly one severity. Subagents MUST justify the severity choice using the rubric below; H3 triage MAY upgrade or downgrade with justification in the ledger.

| Severity | Definition | Examples |
| --- | --- | --- |
| **CRITICAL** | Claim is false in a way that would break downstream implementation or create security/compliance exposure | (a) Doc claims V1 ships feature X; ADR-015 says V1.1. (b) Doc references a normative spec that does not exist. (c) Cited CVE number mismatch in security-invariant doc. (d) ADR status says `active` but an amendment row says `superseded by ADR-0XX`. (e) Numeric claim contradicts a cited source (e.g., "Cloudflare limit is 10,000 rps" — actual limit is 1,000). |
| **MAJOR** | Citation drift, internal contradiction, or coverage gap that would confuse a reader and/or cause follow-up rework but does not block implementation | (a) External citation URL returns 404 (target moved); content still exists at new URL. (b) `per Spec-XXX §Y` reference where Spec-XXX exists but §Y does not. (c) V1 count in doc A says 17, doc B says 16 (both before and after Session M; but the mismatch itself). (d) Plan claims a dependency that the target plan doesn't reciprocate. (e) BL Resolution cites session letter but not commit SHA. |
| **MINOR** | Cosmetic or formatting drift where meaning is preserved | (a) Link format drift: `[text](url)` vs `[text](url "title")` — URL same. (b) Whitespace, trailing space, tab/space mix. (c) Terminology variance (e.g., "local-only" vs "local only") where target doc uses both interchangeably. (d) Section heading-level inconsistency that doesn't break markdown rendering. (e) Timestamp format variance (`2026-04-22` vs `Apr 22, 2026`) within the same doc or across docs. |

**Escalation clause:** if a MINOR finding touches a sensitive surface (ADR status field, CVE citation URL, security-invariant quote, normative `MUST`/`SHOULD` language), escalate to MAJOR. Subagent records escalation rationale in the ledger.

**Ambiguous-severity policy:** if a subagent cannot classify with confidence, default to MAJOR and flag `severity-ambiguous: true` in the ledger for H3 adjudication.

---

## 7. Ledger Schema

The audit ledger lives at `docs/audit/session-h-final-ledger.md` (permanent artifact — see §10 and §13). Each finding is one entry. The schema is:

```
{
  finding-id: "SHF-<lane>-<NNN>"  // e.g., "SHF-A-001"
  lane: <A | B | C | D | E | F | G | H | I | J | K | L>
  finding-source: <h2 | remediation-time>  // h2 = discovered by subagent during H2 dispatch; remediation-time = surfaced during H6 under frozen-discovery rule (§2)
  doc-path: "docs/specs/017-workflow-authoring-and-execution.md"
  line-range: "40-42"  // inclusive, 1-indexed
  claim-text: "<verbatim excerpt of the claim being audited>"
  cited-source: "<URL | doc-path | spec-id | 'none'>"
  evidence-quote: "<verbatim excerpt from cited source, OR 'N/A' for existence-only lanes>"
  verdict: <MATCH | DRIFT | ORPHAN | MISSING | NOISE>
  severity: <CRITICAL | MAJOR | MINOR>
  severity-ambiguous: <true | false>
  severity-rationale: "<one-sentence justification for severity>"
  verdict-rationale: "<one-sentence explanation of why the verdict applies>"
  remediation-status: <found | confirmed | remediated | deferred | false-positive>  // canonical lifecycle state; single source of truth for whether the finding is closed
  remediation-plan-ref: "<H5 plan section ID | null>"
  remediation-commit-sha: "<SHA | null>"
  pre-text-hash: "<SHA-256 of pre-remediation line range | null>"
  post-text-hash: "<SHA-256 of post-remediation line range | null>"
  pre-seeded: <true | false>  // true for Resolution §7 items; see §9.2
  pre-seed-outcome: <confirmed-deferred | partially-addressed | silently-dropped | escalate-to-new-BL | null>  // REQUIRED when pre-seeded=true; null otherwise
  escalated-bl-ref: "<BL-XXX | null>"  // populated when pre-seed-outcome = escalate-to-new-BL
  notes: "<optional free-form notes>"
}
```

**Field separation rationale:** `remediation-status` is the canonical lifecycle enum (machine-verifiable: is this finding closed?). `pre-seed-outcome` is the classification of *how* a pre-seeded deferral resolved. `finding-source` is the discovery-origin (H2 vs remediation-time). These three are orthogonal — a subagent or H3 triager fills each independently, without cross-referencing narrative prose.

**Pre-seed-outcome to remediation-status mapping:** when `pre-seeded: true`, the `pre-seed-outcome` determines the canonical `remediation-status`:

| `pre-seed-outcome` | Maps to `remediation-status` | Notes field requirement |
| --- | --- | --- |
| `confirmed-deferred` | `deferred` | Rationale for continued deferral |
| `partially-addressed` | `remediated` | Residual drift description + whether it warrants a new BL |
| `silently-dropped` | `false-positive` | How the drift was incidentally resolved |
| `escalate-to-new-BL` | `deferred` | `escalated-bl-ref` populated; new BL's rationale |

**Rendering:** ledger uses markdown tables per lane for readability; the JSON schema above is canonical for automated processing if needed.

**Hash commitment:** H6 remediation MUST compute SHA-256 of the pre-remediation line range and record `pre-text-hash` before editing. `post-text-hash` is recorded after the edit. This makes post-audit verification trivial (re-hash the line range; compare).

**Verdict-to-remediation-status mapping:**

| Verdict | Initial `remediation-status` | Final states |
| --- | --- | --- |
| MATCH | `confirmed` | `confirmed` (no remediation needed) |
| DRIFT | `found` | `remediated` or `false-positive` |
| ORPHAN | `found` | `remediated` or `deferred` (if orphan target is external and out of our control) |
| MISSING | `found` | `remediated` or `deferred` |
| NOISE | `found` | re-audit required; transitions to one of the above |

---

## 8. Subagent Prompt Contract

### 8.1 Verbatim-Quote-or-Reject Rule

Every H2 subagent finding MUST include:

1. **`claim-text`** — verbatim substring from the doc being audited, including enough surrounding context to make the claim unambiguous. No paraphrase. No summarization.
2. **`evidence-quote`** — verbatim substring from the cited source (external URL content, another doc, etc.) that supports the verdict. For existence-only lanes (C, E-for-file-existence), `evidence-quote` is `N/A` and the verification primitive is file-existence or HTTP 2xx.

A finding without both fields, or with paraphrased/summarized content in either field, is **rejected at H3 triage** and does not enter the ledger. The subagent MUST re-run for the lane item that produced the rejected finding, or H3 triage MUST re-dispatch a targeted subagent for that item.

**Rationale:** verbatim quotes are anti-hallucination insurance. Claims grounded in exact substrings can be mechanically verified by H3 triage and the advisor. Paraphrased claims are ambiguous and audit-opaque.

### 8.2 Output Schema

Each subagent writes findings to a dedicated file under `docs/audit/session-h-final-h2-findings/`:

```
docs/audit/session-h-final-h2-findings/
  lane-A-external-citation-existence.md
  lane-B-external-citation-quote-fidelity.md
  lane-C-internal-cross-reference-validity.md
  ...
  lane-L-adr-status-consistency.md
```

Each lane file is a markdown table keyed by `finding-id`, with columns matching the §7 ledger schema. H3 triage consolidates all 12 lane files into `docs/audit/session-h-final-ledger.md`.

### 8.3 Safety Clause: Credential and Secret Exclusion

Subagents MUST NOT capture credentials, API keys, tokens, private keys, or connection strings in `evidence-quote`. If a subagent encounters a string matching common secret patterns (e.g., `sk-`, `AKIA`, `-----BEGIN`, base64-encoded strings longer than 40 chars in a credentials context), the subagent:

1. Truncates the string in `evidence-quote` to `<REDACTED: matches secret pattern>`.
2. Flags the finding with `notes: "secret-pattern-redacted"`.
3. Records the doc-path and line-range so H3 can escalate a separate security review.

**Rationale:** the AI Sidekicks repo is pure-docs pre-Plan-001, so the real risk is near-zero. The clause exists because (a) research/ citations could embed curl examples or test fixtures, (b) cheap-to-specify now, expensive-to-bolt-on later, and (c) closes the "no vulnerabilities introduced" framing.

### 8.4 Dispatch Specification (H2 subagent invocation contract)

Each of the 12 lane subagents is invoked as a separate `Agent` tool call with `subagent_type: "general-purpose"` (or a specialized subagent if one matches the lane's primitive more precisely). Each subagent prompt MUST include:

- Lane ID and name (from §5)
- Lane's verification primitive (exact language from §5 table)
- Severity rubric (§6) inline
- Ledger schema fields required in output (§7)
- Verbatim-quote-or-reject rule (§8.1)
- Output file path (§8.2)
- Safety clause (§8.3)
- In-scope corpus (§3) and out-of-scope exclusions (§4)
- Pre-audit inventory pointer (§9) so subagents know which docs have highest citation density
- Instruction: "Write findings to the output file under `docs/audit/session-h-final-h2-findings/` before returning. Do not rely on your task-output summary for correctness — the file is authoritative."

This persistence requirement mirrors the research-standards discipline (memory: `feedback_research_standards.md`): subagent output must be durable before return.

---

## 9. Pre-Audit Inventory

### 9.1 Session M Citation Surface (High-Scrutiny Docs)

Session M (commit `6480419`) introduced substantial new citation surface across 10 files. H2 subagents MUST audit these with enhanced scrutiny because the citation density is highest and the content is newest:

| Doc | Session M change summary | Citation density |
| --- | --- | --- |
| `docs/specs/017-workflow-authoring-and-execution.md` | Full rewrite (477 lines); absorbed 27 amendments SA-1…SA-23 + SA-25–28; I1–I7 security invariants with inline CVE citations | Very high |
| `docs/plans/017-workflow-authoring-and-execution.md` | Rewritten (152 lines); absorbed SA-24/29/30/31; Temporal `runReplayHistory` contract citation | High |
| `docs/architecture/schemas/local-sqlite-schema.md` | Major expansion (437→765 lines); full 9-table Pass G §2 DDL with Pass G research citation comments | Very high |
| `docs/decisions/015-v1-feature-scope-definition.md` | V1 count 16→17 amendment; §Amendment History + §Decision Log + §V1.1 Criterion-Gated Commitments added | High |
| `docs/architecture/v1-feature-scope.md` | 8 edits; Feature 17 promoted V1.1→V1; counts updated; Spec/Backlog Coverage assessments | Medium |
| `docs/architecture/cross-plan-dependencies.md` | 4 edits; §3 Plan-017 row expanded 2-of-6 to full 6-dep; §5 Tier 8 placement; §V1.1+ placeholder rewrite | Medium |
| `docs/decisions/020-v1-deployment-model-and-oss-license.md` | 6 lines; 16→17 count propagation | Low |
| `docs/decisions/017-shared-event-sourcing-scope.md` | 2 lines | Low |
| `docs/architecture/deployment-topology.md` | 2 lines | Low |
| `docs/backlog.md` | BL-097 Resolution block citation-fidelity fixes | Contextual (Resolution block is §7 anchor) |

H2 subagents covering lanes A, B, C, D, H, K, L in particular should schedule extra passes over these 10 docs.

### 9.2 Resolution §7 Pre-Seeded Findings (4 items)

Four items were flagged in BL-097 Resolution §7 (Session M) as non-blocking follow-ups out of BL-097's resolution scope but within Session H-final's audit scope. These are **pre-seeded** — logged in the ledger at H1 time with `pre-seeded: true`. H2 subagents MUST verify each pre-seeded finding and populate the `pre-seed-outcome` field (§7 schema) with exactly one of:

- `confirmed-deferred` — drift still exists in the corpus; deferral rationale still holds; no new BL needed. Maps to `remediation-status: deferred`.
- `partially-addressed` — drift partially resolved by intervening work; ledger `notes` records the residual. Maps to `remediation-status: remediated`.
- `silently-dropped` — drift no longer exists in the corpus (e.g., fixed incidentally). Maps to `remediation-status: false-positive`.
- `escalate-to-new-BL` — drift has become load-bearing for a V1 feature; Session H-final files a new BL (populates `escalated-bl-ref`). Maps to `remediation-status: deferred`.

| Pre-seed ID | Lane | Source | Claim to verify |
| --- | --- | --- | --- |
| **SHF-preseed-001** | L (+ possibly A) | BL-097 Resolution §7(a) | "SQLite STRICT cross-cutting ADR not yet drafted; Plan-017 schema deferred STRICT adoption per this proposed ADR using the repo's existing TEXT-column convention" — verify Plan-017 schema references STRICT or its absence; check no ADR drafted for STRICT adoption; classify outcome. |
| **SHF-preseed-002** | B (+ K) | BL-097 Resolution §7(b) | "Pass G §2 inherited-pragma drift — `synchronous=FULL` claim in Pass G research vs the schema-file pragma block" — verify `docs/architecture/schemas/local-sqlite-schema.md` pragma block vs Pass G research §2 synchronous claim; classify outcome. |
| **SHF-preseed-003** | C (+ D) | BL-097 Resolution §7(c) | "`cross-plan-dependencies.md §3` legend drift — six post-rewrite plans (011/021/022/023/025/026) use `declared in plan header` label not in the legend at lines 83-84" — verify the 6 named plan rows; verify legend content; classify outcome. |
| **SHF-preseed-004** | E (+ H) | BL-097 Resolution §7(d) | "`packages/contracts/src/` subdirectory convention tension — Plan-017's `workflows/` subdir vs §2 line 70 single-file-per-contract convention" — verify Plan-017 declaration; verify cross-plan-dependencies §2 convention language; classify outcome. |

Pre-seeded findings flow into H3 triage alongside H2-discovered findings; the `pre-seeded: true` flag and the `pre-seed-outcome` field together encode the pre-seed-specific decision (§7 schema is the single source of truth — no cross-referencing this narrative section is required to populate ledger fields).

### 9.3 Research Directory Exclusion (Explicit)

`docs/research/` is explicitly out of scope for H2 audit. Subagents MUST NOT:

- Open research files to audit their internal drift
- Flag findings *within* research files

Subagents MUST:

- Follow citation trails *from* research files into downstream docs (i.e., if Spec-017 claims "per Pass G §2", lane B verifies the quote against Pass G content — but Pass G is the trusted source, not the audit target)
- Treat research files as frozen-in-time references

Rationale: the research-standards discipline treats research passes as snapshot artifacts. Research drift from newer external sources is caught at re-research time, not at audit time.

---

## 10. Remediation Workflow (H6)

### 10.1 Minor-Drift Inline Fix Policy

MINOR-severity findings are remediated inline during H6 in the same commit as MAJOR/CRITICAL fixes. The ledger's `severity` field classifies each change so post-audit review can filter.

No separate MINOR-batch BL is filed. Exception: if MINOR drift is escalated to MAJOR per the §6 sensitivity clause, the escalated finding follows MAJOR workflow.

### 10.2 Pre-Remediation Rollback Tag

Before the first edit in H6, an annotated git tag is created:

```
git tag -a pre-session-h-final-remediation -m "Audit rollback point before H6 remediation writes"
```

This tag is the rollback anchor. If H7 advisor review finds systematic error in H6 edits (e.g., subagent hallucination landed in multiple files), the rollback is:

```
git reset --hard pre-session-h-final-remediation
```

The tag is **not** deleted after H8 — it remains as a durable audit artifact.

### 10.3 Commit Ordering (Single Commit — Amended 2026-04-22 per META-1)

Session H-final closes with **a single commit**:

- **`Session H-final: comprehensive drift audit — ledger + remediations + H5 plan`** — H6 remediation edits + ledger finalization + H5 remediation plan artifact. Single focused review.

**Amendment rationale (2026-04-22):** The original §10.3 prescribed a two-commit close where commit (1/2) landed the Apache-2.0 LICENSE. H3 META-1 verified LICENSE is already present in the repo (committed 2026-04-17 as `45434c3 chore: add LICENSE (Apache-2.0) per BL-083`), so the LICENSE-landing commit would have zero content. Single-commit close remains in keeping with the one-commit-per-session convention (Sessions L, M).

**Historical note:** prior to this amendment, §10.3 prescribed the two-commit ordering. Both the ledger META-1 section and this amendment record the amendment date.

---

## 11. Advisor Cadence

Advisor calls are gated at two points, not per lane:

- **Post-H3 (triage-review gate):** after findings consolidation and severity triage, before H5 remediation planning. Advisor reviews: are the 12 lanes' findings consistent? are severities applied uniformly? are any findings hallucinated (ungrounded in real doc content)? are §7 pre-seeds classified correctly?
- **Post-H7 (post-remediation review gate):** after H6 remediation writes land (behind the rollback tag), before H8 commit. Advisor reviews: do the remediation edits match the findings? did any edit introduce new drift? is the ledger accurately updated with commit SHAs and text hashes?

No per-lane advisor calls during H2. Rationale: H2 runs 12 subagents in parallel; per-lane advisor review would serialize the audit and defeat the parallelism.

---

## 12. Dispatch Gates

Two explicit user approvals are required during this audit:

1. **Post-H1 gate (this doc):** user approves the scope-lock before H2 subagent fleet dispatch. The user may amend H1 before approval (adding lanes, tightening severity, etc.). This doc is the artifact under approval.
2. **Post-H5 gate:** user approves the remediation plan before H6 edits land. Advisor post-H3 gate has fired at this point; user sees both the findings ledger and the remediation plan.

Additionally:

- **Post-H7 (advisor gate):** not a user gate, but no H8 commit without advisor pass.
- **H8 commits:** per §10.3, two commits. No user gate between them (the session is approved as a unit at post-H5).

---

## 13. Completion Criteria

Session H-final is complete when **all** of the following hold:

1. The ledger at `docs/audit/session-h-final-ledger.md` contains one entry per finding (H2-discovered + remediation-time + pre-seeded), all with terminal `remediation-status` (`confirmed`, `remediated`, `deferred`, or `false-positive` — no `found` remaining).
2. Every entry with `pre-seeded: true` has a populated `pre-seed-outcome` field (non-null); every `escalate-to-new-BL` outcome has a populated `escalated-bl-ref`.
3. The pre-remediation rollback tag `pre-session-h-final-remediation` exists in the repo.
4. Both commits (LICENSE 1/2, audit 2/2) have landed on `main` with clean advisor post-H7 pass.
5. The **fresh-Opus-4.7 test:** a new Opus 4.7 session, given only the post-H-final doc corpus and no conversational context, can read the docs required to execute Plan-001 and begin code work without blocking on doc clarification.

The completion criteria are verified by H8. If any criterion fails, H8 blocks and the audit re-enters the appropriate prior phase.

---

## Related Artifacts

- [BL-097 Resolution block](../backlog.md) — §7 pre-seeded findings source
- [ADR-015 V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md) — V1 count authority (17) for lane G
- [ADR-020 V1 Deployment Model and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md) — LICENSE authority for H8 (1/2) commit
- [cross-plan-dependencies.md](../architecture/cross-plan-dependencies.md) — lane H + §9.2 SHF-preseed-003 target
- [Session M commit `6480419`](https://github.com/) — citation-surface baseline for §9.1

## Related Memories

- `feedback_doc_first_before_coding.md` — audit's gating role before Plan-001
- `feedback_research_standards.md` — research/ directory exclusion rationale (§4, §9.3)
- `feedback_citations_in_downstream_docs.md` — underpins lane B (external citation quote fidelity)
