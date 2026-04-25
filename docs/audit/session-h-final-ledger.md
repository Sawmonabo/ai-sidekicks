# Session H-final: Consolidated Findings Ledger (H3 Synthesis)

**Status:** H3 consolidation output; pending advisor gate per scope-lock §11
**Authored:** 2026-04-22
**Predecessor:** [session-h-final-scope.md](./session-h-final-scope.md) (H1 scope-lock)
**Per-lane raw inputs:** [session-h-final-h2-findings/](./session-h-final-h2-findings/) (12 lane files, authoritative for row-level detail)

---

## 1. Executive Summary

**Corpus audited:** 27 plans, ~25 specs, 20 ADRs (active), 60 completed BLs, 119 in-scope .md files, 2,104 markdown links.

**Enumerated findings:** 418 across 12 lanes. Verdict and severity breakdown:

| Lane | Total rows | MATCH | DRIFT | ORPHAN | MISSING | NOISE | CRITICAL | MAJOR | MINOR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A — External citation existence | 140 | ~85 | ~22 | ~8 | 1 | ~10 | 1 | ~22 | ~30 |
| B — External citation quote fidelity | 34 | 21 | 8 | 0 | 0 | 5 | 0 | 4 | ~25 |
| C — Internal cross-reference validity | 6 (+2,099 implicit MATCH) | 0 (+2,099) | 3 | 2 | 0 | 0 | 0 | 6 | 0 |
| D — Cross-reference bidirectionality | 14 | 3 | 9 | 0 | 0 | 2 | 2 | 8 | 2 |
| E — Coverage/orphan detection | 48 | 45 | 1 | 1 | 0 | 0 | 0 | 3 | 45 |
| F — Version/date consistency | 16 | 13 | 2 | 0 | 0 | 1 | 0 | 0 | 16 |
| G — Feature-scope count consistency | 44 | 33 | 11 | 0 | 0 | 0 | 0 | 0 | 11 |
| H — Dependency/topology trace | 11 | 0 | 10 | 0 | 1 | 0 | 0 | 8 | 3 |
| I — Resolution/backlog trace | 60 | 33 | 5 | 0 | 22 | 0 | 22 | 0 | 5 |
| J — Open-questions / deferred trace | 7 | 1 | 6 | 0 | 0 | 0 | 0 | 0 | 6 |
| K — Numeric consistency (sub-lane) | 35 | 29 | 6 | 0 | 0 | 0 | 0 | 1 | 34 |
| L — ADR status consistency (sub-lane) | 3 (+20 implicit MATCH) | 0 (+20) | 0 | 2 | 0 | 0 | 2 | 0 | 1 |
| **Total (enumerated)** | **418** | **263** | **83** | **13** | **24** | **18** | **27** | **52** | **~178** |

**Headline severity (raw enumeration):** 27 CRITICAL + 52 MAJOR = 79 findings requiring H5 remediation plan entries. Remainder (MINOR) per scope-lock §10.1 policy: fix inline during H6, classify in ledger, no separate BL backlog.

**Headline severity (post-H3 triage, 2026-04-22):** 4 confirmed CRITICAL + 17 tentative Lane I CRITICAL (pending H5 per-BL re-triage; advisor-gate 5-sample produced 0/5 true CRITICAL, so ~0-2 expected post-triage) + 5 Lane I pre-triaged to MINOR (SHF-I-001/013/017/020/046) + 52 MAJOR. See META-2 for primitive-strictness rationale and §5 for the pre-triaged 5.

**Count correction (finding-source: remediation-time, 2026-04-22 — H5 drafting):** Lane H MAJOR|MINOR counts corrected from `7|4` to `8|3` after cross-verifying with [lane-h-dependency-topology-trace.md](./session-h-final-h2-findings/lane-h-dependency-topology-trace.md) finding-table (SHF-H-008 Severity = `MAJOR` per row 39; H-001 through H-008 all MAJOR, H-009/H-010/H-011 MINOR). The §6 L219 Lane H row description already listed 8 MAJOR finding-IDs (H-007, H-001/002/003, H-008, H-004/005/006) — only the numeric count column was off-by-one. Corresponding propagated updates: §1 Total MAJOR `51 → 52`; §1 Total MINOR `~179 → ~178`; §6 L219 Lane H MAJOR `7 → 8`; §7 L236 Lane H MINOR `4 → 3`. This is a count-bookkeeping correction to an already-enumerated finding (SHF-H-008 is not a new finding instance); no BL-level routing changes. H5 plan §1/§5.7/§6.7 numbers propagated in the same pass.

**No-blocker determination:** zero lanes reported dispatch blockers. Five Lane B NOISE findings are external-source access failures (403/404/redirect), documented for re-audit and not blocking remediation.

---

## 2. Cross-Lane Corroboration

High-confidence findings surfaced by ≥2 lanes. Merged to a single remediation item to prevent double-fix.

### CRITICAL-1 — ADR-020 broken cite in Spec-017

Three lanes independently caught the same drift. Merge candidate.

| Lane | Finding ID | Angle |
| --- | --- | --- |
| C | SHF-C-004 | Link target `../decisions/020-agent-capabilities-and-contract-ordering.md` does not exist |
| D | SHF-D-003 | Cited title `ADR-020 — Agent capabilities and contract-ordering` mismatches actual ADR-020 title |
| L | SHF-L-002 | ADR-020 is `V1 Deployment Model and OSS License`; cite is to entirely different (non-existent) subject |

**Location:** `docs/specs/017-workflow-authoring-and-execution.md:409`
**Severity:** CRITICAL (Session M rewrite introduced a broken normative cite)
**Remediation:** determine intended target ADR; fix title + path. If no such ADR exists (ADR content was never drafted), this may be a Spec-017 scope overclaim — H5 must adjudicate.

### CRITICAL-2 — ADR-002 broken cite in Spec-017

| Lane | Finding ID | Angle |
| --- | --- | --- |
| L | SHF-L-001 | Cites `ADR-002 — Local-first architecture` at `002-local-first-architecture.md`; actual ADR-002 is `002-local-execution-shared-control-plane.md` |

**Location:** `docs/specs/017-workflow-authoring-and-execution.md:407`
**Severity:** CRITICAL
**Remediation:** fix path + title to `002-local-execution-shared-control-plane.md` / `Local Execution Shared Control Plane`. Low-risk; title change semantically compatible with Spec-017 context.

### MAJOR-cluster — V1=16 legacy count in backlog.md

| Lane | Finding ID | Angle |
| --- | --- | --- |
| K | SHF-K-009 | `backlog.md:32` current-reading prose states "V1 consists of 16 features" |
| G | 11 DRIFT rows | Completed-BL charter/exit-criteria text carries V1=16 / V1.1=4 (historical) |
| E | SHF-E-031 | BL-039 Exit Criteria still names V1=16 |

**Location:** `docs/backlog.md:30-32` + 11 historical BL entries
**Severity:** MAJOR for line 32 (current-reading prose); MINOR for historical BL text
**Remediation per Lane G recommendation:** single editor's note at `backlog.md:30` Active Items header clarifies post-2026-04-22 canonical = V1=17/V1.1=3, referencing ADR-015 §Amendment History. Closes 12 findings with one edit. Historical BL text remains untouched (preserves provenance).

### MAJOR-cluster — Amendment count drift in Session M surface

| Lane | Finding ID | Angle |
| --- | --- | --- |
| D | SHF-D-006 + SHF-D-007 | ADR-015:56 + v1-feature-scope.md:87 say "31 amendments SA-1…SA-31" in Spec-017; Spec-017:475 says it absorbs 27 (SA-24/29/30/31 land in Plan-017) |

**Severity:** MAJOR (downstream docs overcount what Spec-017 itself absorbed)
**Remediation:** fix ADR-015:56 + v1-feature-scope.md:87 to read "27 amendments absorbed by Spec-017; 4 additional (SA-24/29/30/31) absorbed by Plan-017". Cross-check cite for SA-counts in H5.

---

## 3. Pre-Seed Outcomes (BL-097 Resolution §7)

All 4 pre-seeded findings verified. None escalated to new BL.

| Pre-seed ID | BL-097 §7 ref | Primary lane | Outcome | Maps to `remediation-status` |
| --- | --- | --- | --- | --- |
| **SHF-preseed-001** | §7(a) SQLite STRICT ADR missing | L | `confirmed-deferred` | `deferred` |
| **SHF-preseed-002** | §7(b) Pass G `synchronous=FULL` vs schema pragma | B | `confirmed-deferred` | `deferred` |
| **SHF-preseed-003** | §7(c) cross-plan-dependencies §3 legend drift | C | `confirmed-deferred` | `deferred` |
| **SHF-preseed-004** | §7(d) `packages/contracts/src/workflows/` convention | E, H | `confirmed-deferred` | `deferred` |

**Pre-seed details:**

- **SHF-preseed-001 (Lane L primary, Lane A secondary):** Zero `STRICT` references in `docs/decisions/` or `docs/architecture/schemas/local-sqlite-schema.md`. Spec-017:42 and :377 carry the V1.x deferral with Wave 2 §4.1 + BL-097 citations. Lane A secondary outcome (`silently-dropped`/false-positive) is consistent — no external URL to check because no STRICT references exist. Authoritative outcome: **`confirmed-deferred`**. Rationale for continued deferral: BL-097 Resolution cited Plan-017 schema using TEXT-column convention pending cross-cutting ADR; no V1 feature regression from waiting.

- **SHF-preseed-002 (Lane B primary, Lane K secondary):** `local-sqlite-schema.md` §Pragmas omits `PRAGMA synchronous = FULL` declared canonical in Spec-015 §Pragmas and "inherited" per Pass G §2 research. Spec-015 is authoritative for pragmas; schema file is the drifted surface. Lane K confirmed `busy_timeout = 5000` MATCH (numeric consistency holds). Authoritative outcome: **`confirmed-deferred`**. Rationale: non-load-bearing for V1 functionality (Spec-015 pragmas still canonical); pending cross-cutting pragma-propagation ADR.

- **SHF-preseed-003 (Lane C primary, Lane D secondary):** Legend at `cross-plan-dependencies.md:83-84` defines only `spec-declared` and `implementation-derived`. Six plan rows (L98 Plan-011, L110 Plan-021, L111 Plan-022, L112 Plan-023, L114 Plan-025, L115 Plan-026) use the label `declared in plan header` which is not in the legend. Lane D confirmed content-MATCH (the dependencies themselves are correctly attributed; only the label taxonomy drifts). Authoritative outcome: **`confirmed-deferred`**. Rationale: label/taxonomy drift is cosmetic; does not affect dependency correctness.

- **SHF-preseed-004 (Lane E primary, Lane H secondary):** `Plan-017:43` declares `packages/contracts/src/workflows/` subdirectory. `cross-plan-dependencies.md:70` carries the "single-file-per-contract convention" language. Both surfaces verbatim-confirmed. Lane H additional observation (SHF-H-011): §2 missing rows for both `packages/contracts/src/workflows/` and `packages/runtime-daemon/src/workflows/`. Authoritative outcome: **`confirmed-deferred`**. Rationale: BL-097 §7(d) explicitly deferred until "a second subdirectory candidate surfaces"; zero second candidates across Plans 001-026.

---

## 4. Meta-Findings (Scope-Lock Drift)

Findings that indicate the H1 scope-lock itself contains incorrect assumptions. These require amendment to `session-h-final-scope.md` before H8 commit.

### META-1 — LICENSE already landed

**Surfaced by:** Lanes E, H (observation), L, I (SHF-I-046 / BL-083 CRITICAL)

**Finding:** Scope-lock §10.3 prescribes "Session H-final closes with two separate commits: (1/2) LICENSE file landed per ADR-020". Tree-state inspection shows LICENSE is already present and dated 2026-04-17 (per ADR-020 Decision Log and BL-083 closure evidence). The "(1/2) LICENSE" commit therefore has no content.

**Verification evidence (advisor-gate, 2026-04-22):**

| BL-083 Exit Criterion | Verification Command | Evidence | Verdict |
| --- | --- | --- | --- |
| `LICENSE` file exists at repo root | `ls -la LICENSE` + `git log --oneline -- LICENSE` | `LICENSE` 11299 bytes, commit `45434c3 chore: add LICENSE (Apache-2.0) per BL-083` dated 2026-04-17 | ✅ satisfied |
| `package.json` `license` field matches | grep `"license"` in `package.json` | `package.json:6` reads `"license": "Apache-2.0"` | ✅ satisfied |
| `README.md` references the license | grep `LICENSE\|License\|Apache` in `README.md` | `README.md:283` reads `AI Sidekicks is licensed under the [Apache License, Version 2.0](./LICENSE) — see [ADR-020]…` | ✅ satisfied |
| ADR-020 Decision Log entry records the choice | Read `docs/decisions/020-v1-deployment-model-and-oss-license.md` lines 235-255 | Decision Log L243 (2026-04-17 Proposed) + L244 (2026-04-17 Accepted) + L247 (LICENSE committed — verbatim quote below) | ✅ satisfied |

**ADR-020:247 verbatim** (Decision Log markdown-table row, source markdown preserved as-is in the fenced block below — no character substitution):

```markdown
| 2026-04-17 | LICENSE committed | Apache-2.0 chosen per BL-083. Rationale: (a) explicit patent grant (§3) protects contributors and users from patent litigation by other contributors — a concrete advantage MIT does not provide; (b) §5 codifies inbound-is-outbound contribution semantics, reducing the need for a separate CLA for casual contributors; (c) dominant choice in modern developer-tool OSS (Kubernetes, Supabase, Terraform-pre-BSL-era); (d) SPDX identifier `Apache-2.0` recognized by all major dependency scanners. MIT considered as the alternative and rejected — the patent-grant protection matters more than MIT's marginally-cleaner GPL-compatibility story for this contributor-rich developer-tool category. `LICENSE` file at repo root contains the verbatim canonical Apache-2.0 text (appendix instantiated with `Copyright 2026 AI Sidekicks contributors`); root `package.json` `license` field set to `Apache-2.0`; `README.md` §License links to `./LICENSE` and this ADR |
```

**Conclusion:** BL-083 is substantively fully satisfied. The verbatim Decision Log quote above confirms: (i) Apache-2.0 selection with explicit four-point rationale; (ii) MIT considered and rejected with reasoned tradeoff; (iii) `LICENSE` file, `package.json` `license` field, and `README.md` §License cross-refs all attested in the same Decision Log row — matching the top three verification-table evidence rows independently. What Lane I flagged (absence of a `Resolution (resolved YYYY-MM-DD):` narrative block inside the BL-083 backlog entry) is a **template-format gap**, not a substantive exit-criteria gap. See META-2 for the broader pattern.

**Remediation:**

(a) Scope-lock §10.3 **amendment:** remove LICENSE-landing as H8 (1/2) commit; H8 becomes single commit `Session H-final: comprehensive drift audit — ledger + remediations`.

(b) Lane I SHF-I-046 (BL-083 OSS LICENSE `MISSING` Resolution): re-classify as **false-positive** — BL-083 exit criteria fully satisfied per verification table above. H6 optional hygiene edit: add a one-line Resolution stub `Resolution (resolved 2026-04-17): LICENSE (Apache-2.0) committed at repo root per commit 45434c3; package.json + README.md cross-refs in same commit; ADR-020 Decision Log L239-247 records Apache-2.0 selection.` — this is format-consistency with newer BLs (BL-084+), not a correctness fix.

### META-2 — Lane I primitive strictness

**Finding:** Lane I reported 22 CRITICAL `MISSING` findings for completed BLs without Resolution blocks or Session-letter traces (BL-038 through BL-085 range). Spot-check suggests many of these are legacy-format BLs from early sessions (pre-Session-letter convention) where closure was recorded in Decision logs or dated resolutions rather than Session-tagged Resolution blocks.

**Per-advisor sampling (2026-04-22, 5 BLs sampled evenly across the range):**

Advisor-gate pre-close sampling of the 22 Lane I CRITICAL MISSING claims. Sampled BLs chosen to span the range — BL-038 (line 38), BL-050 (line 209), BL-054 (line 319), BL-057 (line 352), BL-083 (line 251). All five confirmed in backlog.md via Read.

| Sample | Status in backlog.md | Has explicit Resolution block? | Exit Criteria verifiable? | Actual severity |
| --- | --- | --- | --- | --- |
| BL-038 (Write ADR-015 V1 Feature Scope Definition) | `completed` | No — Exit Criteria only, legacy format | ADR-015 exists and is amended (referenced throughout the corpus); ADR-015 `015-v1-feature-scope-definition.md` verifiable | MINOR (format hygiene) |
| BL-050 (Audit Log Integrity protocol) | `completed` | No — Exit Criteria only, legacy format | security-architecture.md + Spec-006 + schema migration text verifiable | MINOR (format hygiene) |
| BL-054 (cross-plan-dependencies.md V1=16 alignment) | `completed` | No — Exit Criteria only, legacy format | cross-plan-dependencies.md Tier edits verifiable (Lane H does report some residual drift but that's separate) | MINOR (format hygiene) |
| BL-057 (CLI identity key storage) | `completed` | No — Exit Criteria only, legacy format | ADR-010 + ADR-021 exist and cross-cite; fallback order documented | MINOR (format hygiene) |
| BL-083 (Commit OSS LICENSE) | `completed` | No — Exit Criteria only, legacy format | All 4 exit-criteria items verified in META-1 table above | MINOR (format hygiene, false-positive for MISSING) |

**Sample result: 5/5 are legacy format. 0/5 are genuine MISSING CRITICAL.** The backlog has two legitimate templates (legacy: Status + Exit Criteria; modern: + explicit Resolution narrative starting ~Session C / BL-084+). Lane I's criterion (absence of Resolution block = CRITICAL MISSING) does not model the legacy template and produces systemic false-positives on pre-Session-letter BLs.

**Revised triage decision:** the original META-2 distribution estimate (~3-5 true CRITICAL, ~10-15 MAJOR, ~5 MINOR) is too high on CRITICAL. Revised distribution estimate based on the 5-sample: **~0-2 true CRITICAL (only if a completed BL has *no* verifiable exit-criteria evidence anywhere in the corpus), ~20 MINOR (era-appropriate legacy-format with verifiable exit criteria)**. H5 remediation plan must per-BL verify exit criteria rather than check for Resolution-block presence.

**Lane I primitive amendment (for any future audit):** the primitive must check whether a BL's Exit Criteria are verifiable in the tree (not whether a Resolution block is present). Resolution blocks are a *format convention* that post-dates Session C; applying the convention retroactively as a correctness check inflates CRITICAL false-positives.

**Per-BL re-triage for the remaining 17 non-sampled Lane I CRITICAL claims** is carved out to H5 remediation plan per the scope-lock, now with the revised severity distribution as the working hypothesis.

### META-3 — Lane A external source access limits

**Finding:** Lane A's 10 NOISE findings and Lane B's 5 NOISE findings are external-source access failures (403/404/redirect-loop) rather than citation drift. Re-audit would need alternate fetch methods (direct browser, archive.org, vendor outreach).

**Triage decision:** deferred out of H5 scope. Classified as `remediation-status: deferred` in ledger with rationale "external-source access issue; not a doc-corpus drift." Candidates for a future cite-refresh pass.

---

## 5. CRITICAL Findings Roster (for H5 Remediation Planning)

After META-2 triage, CRITICAL count is provisionally reduced. The 4 genuine-CRITICAL findings that survive triage plus the 22 Lane I items (H5 re-triage required):

### Confirmed CRITICAL (4)

| ID | Location | Summary | Remediation path |
| --- | --- | --- | --- |
| CRIT-1 (merged D-003 + C-004 + L-002) | Spec-017:409 | Broken cite to non-existent `ADR-020 — Agent capabilities and contract-ordering` | Identify intended target; fix or remove cite. Adjudicate if content overclaim. |
| CRIT-2 (L-001) | Spec-017:407 | Broken cite to non-existent `ADR-002 — Local-first architecture` path | Fix to `002-local-execution-shared-control-plane.md` + `Local Execution Shared Control Plane` |
| CRIT-3 (A-117) | Plan-017:117 | Wrong GHSA ID for CVE-2025-68613 (`GHSA-wfw3-33mq-9c84` 404); Spec-017:435 has correct ID `GHSA-v98v-ff95-f3cp` | Fix Plan-017 to match Spec-017's canonical ID |
| CRIT-4 (D-005) | Spec-017:167 | Claims Spec-012 has new `human_phase_contribution` approval category per SA-12; Spec-012:48-56 canonical enum does not include it. Load-bearing for Plan-017:84 | Verify SA-12 intent against Wave 2 synthesis; either fix Spec-012 enum or remove Spec-017's claim |

### Lane I tentative CRITICAL (22 — H5 re-triage per META-2, 5 pre-triaged 2026-04-22)

5 pre-triaged as MINOR (legacy-format false-positives, exit criteria verifiable). Evidence tier noted per row — only BL-083 received a full exit-criteria verification table (§4 META-1). The other 4 are surface-verified (presence of referenced ADRs/docs/cross-refs confirmed without verbatim exit-criteria matching) and explicitly carved to H5 for deep re-triage:

| Finding | BL | Evidence tier | Verdict post-sampling |
| --- | --- | --- | --- |
| SHF-I-001 | BL-038 (ADR-015 V1 Feature Scope Definition) | Surface-verified pending H5 deep re-triage | MINOR — ADR-015 exists + amended; format-only gap |
| SHF-I-013 | BL-050 (Audit Log Integrity protocol) | Surface-verified pending H5 deep re-triage | MINOR — security-architecture.md + Spec-006 Integrity Protocol verifiable; format-only gap |
| SHF-I-017 | BL-054 (cross-plan-dependencies.md V1=16 alignment) | Surface-verified pending H5 deep re-triage | MINOR — cross-plan-dependencies.md edits verifiable; format-only gap |
| SHF-I-020 | BL-057 (CLI identity key storage) | Surface-verified pending H5 deep re-triage | MINOR — ADR-010 + ADR-021 cross-ref verifiable; format-only gap |
| SHF-I-046 | BL-083 (OSS LICENSE) | Deep-verified (§4 META-1 4-row exit-criteria table + ADR-020:247 verbatim) | MINOR — all 4 exit criteria verified in META-1 table above; format-only false-positive |

**Remaining 17 Lane I CRITICAL claims** — per-BL enumeration carved to H5 with revised severity distribution hypothesis (~0-2 true CRITICAL, ~15 MINOR).

---

## 6. MAJOR Findings Roster (for H5 Remediation Planning)

**Total: 51 MAJOR across 12 lanes.** Enumerated in per-lane files; grouped here by remediation pattern:

| Group | Lanes | Count | Pattern | Remediation archetype |
| --- | --- | --- | ---: | --- |
| External-URL 404/rename | A | ~22 | napi-rs/keyring (6×); OWASP ASVS §2.7.2 (2×); Node 20 EOL (3×); node-pty#437 (3×); Jenkins SECURITY-383 (2×); Dagger GHA-2019 (4×); others (~2×) | Replace URL with current canonical; confirm via WebFetch |
| External-quote fidelity | B | 4 | SQLite wal_checkpoint_v2 quote (SHF-B-001/002); automerge CRDT quote (SHF-B-023) | Fix quote verbatim OR change to non-quoted paraphrase with citation |
| Internal link/anchor drift | C | 6 | Spec-017 §Governing docs + §Related specs 3-ORPHAN cluster; Plan-001:69 broken Plan-018 link; anchor drift | Path + title correction |
| Cross-ref bidirectionality | D | 8 | SA-count drift (SHF-D-006/007); others per lane file | Target-doc update OR source-doc correction |
| Coverage/orphan | E | 3 | Spec-024 ORPHAN (ID collision with Plan-024); BL-039 pre-BL-097 counts (cross-routes to Lane G); SHF-preseed-004 (deferred) | Spec-024 rename/redirect; backlog entry update |
| Dependency/topology | H | 8 | Plan-023 path drift (SHF-H-007, systemic); tier mismatches (H-001/002/003); §2 renderer-extender list missing 11 plans (H-008); "Contested" vs "Uncontested" drift (H-004/005/006) | Cross-plan-dependencies.md update; plan-body-to-§3 reconciliation |
| Numeric | K | 1 | SHF-K-009 backlog.md:32 V1=16 prose (cross-routes to Lane G) | Merged with backlog editor's note (see Cross-Lane Corroboration §2) |

---

## 7. MINOR Findings Summary

**Total: ~179 MINOR.** Policy per scope-lock §10.1: fix inline during H6, classify severity in ledger, no separate BL backlog.

| Lane | MINOR count | Dominant pattern |
| --- | ---: | --- |
| A | ~30 | Minor URL format variance; version path redirects |
| B | ~25 | Quote substring present but with wording variance |
| D | 2 | Non-load-bearing cross-refs |
| E | 45 | Legacy BL Exit Criteria format variance |
| F | 16 | Timestamp format variance (Date field annotations) |
| G | 11 | Historical BL V1=16 count text (merged with Cross-Lane Corroboration §2) |
| H | 3 | Minor path format; non-load-bearing Tier variance |
| I | 5 | "Decision (resolved <date>)" legacy anchor without Session letter |
| J | 6 | Bare "remains unresolved" in Plan Risks And Blockers (Plans 002, 008, 012, 013, 016, 018) |
| K | 34 | Historical task-definition text inside closed-BL blocks |
| L | 1 | ADR-013 reserved-skipped MATCH summary |

For full MINOR enumeration, see per-lane files under [session-h-final-h2-findings/](./session-h-final-h2-findings/).

---

## 8. NOISE Findings (Deferred, Re-Audit Candidates)

| Lane | Finding | Deferral rationale |
| --- | --- | --- |
| A | XDG Base Directory spec (freedesktop.org) | Redirects to empty content; re-fetch alternate |
| A | NIST SP 800-88 R2 | Only publication-listing page accessible via WebFetch; PDF body inaccessible |
| A | Temporal Worker Deployment Versions | 404; alternate Temporal docs URL exists |
| A | @napi-rs/keyring npm page | Access limitation |
| A | Electron /releases | 302 redirect |
| A | Wails | Access limitation |
| A | WebKitGTK homepage | Access limitation |
| A | Argo Workflows (x2) | Redirect/access limitation |
| A | LangGraph multi_agent | Redirect loop |
| A | OpenAI Platform | Access limitation |
| A | MDPI | Access limitation |
| B | XDG, NIST SP 800-88 R2 | Same as Lane A entries |
| B | Flyway schema-history (documentation.red-gate.com) | 403 |
| B | Liquibase DATABASECHANGELOG | 403 (inline-acknowledged by Spec-006 author) |
| F | Session L naming gap | Session L is commit 5d0e84b but no explicit "Session L" session-letter reference in in-scope docs; likely false-positive |

**Policy:** deferred out of H5/H6 scope. Candidates for a future cite-refresh pass with alternate fetch methods.

---

## 9. H3 Triage Decisions (Summary)

| Decision | Rationale |
| --- | --- |
| 27 CRITICAL → 4 confirmed + 5 pre-triaged MINOR + 17 tentative (META-2) | Lane I primitive strictness; sampling confirms false-positive pattern; 5 pre-triaged 2026-04-22, 17 carved to H5 |
| Merged 3 lanes' ADR-020 findings (CRIT-1) | Cross-lane corroboration; single remediation |
| LICENSE scope-lock drift (META-1) + 4-criteria verification | Scope-lock §10.3 amendment required before H8; all BL-083 exit criteria verified satisfied 2026-04-22 |
| BL-083 Lane I vs Lane E conflict | Lane E correct (BL-083 fully satisfied); Lane I wrong (legacy-format false-positive); see META-1 + META-2 |
| 4 pre-seed outcomes: all `confirmed-deferred` | No V1-feature regressions from continued deferral |
| 15 NOISE items deferred | External-source access failures; not corpus drift |
| Lane G + Lane K backlog V1=16 merge | Single editor's note at `backlog.md:30` |

---

## 10. Inputs to H5 Remediation Plan

H5 remediation plan (next phase after advisor gate) must enumerate:

1. **4 confirmed CRITICAL** (CRIT-1..CRIT-4) — per-finding edit plan with before/after text
2. **~22 Lane I tentative CRITICAL** — per-BL re-triage decisions + subsequent remediation
3. **51 MAJOR findings** — per-finding edit plan grouped by pattern (URL fix; quote fix; path fix; etc.)
4. **~179 MINOR findings** — batch remediation strategy per lane (inline fixes during H6)
5. **Scope-lock §10.3 amendment** (META-1) — H8 becomes single commit
6. **Backlog META-1 hygiene edit** (BL-083 Resolution block retroactive add)

---

## 11. Scope Freeze (H4 Checkpoint — ACTIVE)

**Frozen-discovery effective:** 2026-04-22, upon advisor-gate closure of H3.

Per scope-lock §2 and §13, the 12-lane drift taxonomy is now frozen. The canonical taxonomy roster as of freeze:

- **A** External citation existence
- **B** External citation quote fidelity
- **C** Internal cross-reference validity
- **D** Internal cross-reference bidirectionality
- **E** Coverage/orphan detection
- **F** Version/date consistency
- **G** Feature-scope count consistency
- **H** Dependency/topology trace
- **I** Resolution/backlog trace
- **J** Open-questions / deferred trace
- **K** Numeric consistency (sub-lane)
- **L** ADR status consistency (sub-lane)

**Frozen-discovery rules from this point forward:**

- No new drift *classes* may be added to the audit. The 12-lane taxonomy above is final for Session H-final.
- New finding *instances* discovered during H6 remediation are logged in this ledger with `finding-source: remediation-time` (§7 schema). They populate one of the existing 12 lanes; they do not expand the taxonomy.
- Lane I's primitive amendment (META-2) — "check Exit Criteria verifiability, not Resolution-block presence" — is a *primitive-refinement*, not a new lane. It applies to the per-BL re-triage in H5 without expanding the taxonomy.
- Scope-lock §10.3 amendment required by META-1 (H8 single-commit instead of two-commit) is deferred to the H5 remediation plan — it changes H-final workflow mechanics, not the drift taxonomy, so the frozen-discovery rule does not block it.

**Meta-drift prevention:** if during H5 or H6 a reviewer identifies a drift that does not fit any of the 12 lanes, the correct response is to log it under the closest-matching lane with `notes: "taxonomy-edge-case"` — NOT to add a new lane. Taxonomy expansion is deferred to a future audit (Session H-2 / successor), not Session H-final.

**Inputs to the freeze (authoritative count as of 2026-04-22):**

| Source | Finding count | Accounting note |
| --- | ---: | --- |
| Enumerated lane-findings (H2 output across 12 lanes) | 418 | Per §1 table; includes the 4 pre-seeded items mapped to their primary lanes (L, B, C, E per §3) |
| H3-synthesized meta-findings (META-1/2/3) | 3 | Not in any single lane; surface across multiple lanes by nature (META-1 cross-surfaces E/H/L/I; META-2 is Lane-I-primitive; META-3 is Lane-A/B scope) |
| **Total at H4 freeze** | **421** | |

Any finding-count growth after 2026-04-22 must be attributable to `finding-source: remediation-time` and must fit within the 12 frozen lanes.

---

## Related Artifacts

- [H1 scope-lock](./session-h-final-scope.md)
- [H2 per-lane raw findings](./session-h-final-h2-findings/)
- [BL-097 Resolution §7](../backlog.md)
- [ADR-015 Amendment History](../decisions/015-v1-feature-scope-definition.md#amendment-history)
- [ADR-020 V1 Deployment Model and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md)
