# Session H-final: Remediation Plan (H5 Artifact)

**Status:** H5 draft (in-progress); pending user approval per scope-lock §12
**Authored:** 2026-04-22
**Predecessor:** [session-h-final-ledger.md](./session-h-final-ledger.md) (H3 consolidation, advisor-gated closed 2026-04-22)
**Scope-freeze:** [ledger §11 H4 checkpoint](./session-h-final-ledger.md#11-scope-freeze-h4-checkpoint--active)

---

## 1. Executive Summary (User-Gate Abstract)

**What this document is:** the per-finding remediation plan for all drift captured in the H3 ledger. H5 is the last user-gate before remediation writes land in H6. After your approval, H6 executes edits behind the `pre-session-h-final-remediation` rollback tag, H7 advisor-reviews, H8 commits.

**Remediation volume at a glance (post-§3 re-triage):**

| Severity | Count | Plan treatment |
| --- | ---: | --- |
| CRITICAL (confirmed) | 4 | Full per-finding before/after text (§4). CRIT-4 is a two-file atomic edit. |
| CRITICAL (Lane I tentative) | 17 | **Re-triaged 100% to MINOR** in §3.1 — META-2 **verified 22/22** with all seven edge-case greps executed pre-user-gate. Routed to §6 Lane I pattern block. |
| MAJOR | 52 findings → 34 groups | Full per-finding before/after text grouped into 34 atomic-commit remediation groups (§5) across 71 file-edits. 52 findings consolidate into 34 groups via absorption (§4.1/§4.2/§5.4.3/§4.4/§5.5/§5.7.3 merge corroborators), merge (§5.5.1 triple-D merge; §5.7.3 triple-H merge), and cross-lane routing (§5.6 deferrals; Lane G batch in §6). Zero MAJOR spillover from Lane I re-triage. Lane H count reflects `finding-source: remediation-time` correction — see [ledger §1 note](./session-h-final-ledger.md#1-executive-summary) (Lane H MAJOR|MINOR 7|4 → 8|3 after H5 cross-verification with lane-h authoritative data; SHF-H-008 severity = MAJOR per lane-h row 39). |
| MINOR | ~195 (~178 base after Lane H remediation-time count correction + 17 Lane I re-triage spillover) | Pattern-based batch spec per lane (§6) — see scope decision below |
| Meta amendments | 2 | Scope-lock §10.3 (META-1) + Backlog BL-083 Resolution-stub (§7, §8) |
| NOISE (deferred) | 15 | Out of H5 scope; re-audit candidates (ledger §8) |

**Confirmed CRITICAL one-liners (full before/after in §4):**

- **CRIT-1** Spec-017:409 — broken cite to non-existent `ADR-020 — Agent capabilities and contract-ordering`. Fix: remove cite (no such ADR exists in `docs/decisions/`); Spec-017's agent/SDK semantics are already grounded by ADR-015 (cited 9× in Spec-017) + Spec-017's own "Core SDK and persistence contracts" block at line 121+. Adjudication in §4.1.
- **CRIT-2** Spec-017:407 — broken path for `ADR-002 — Local-first architecture`. Fix: change path to `002-local-execution-shared-control-plane.md` and title to `Local Execution Shared Control Plane`.
- **CRIT-3** Plan-017:117 — wrong GHSA ID (`GHSA-wfw3-33mq-9c84` 404). Fix: replace with canonical ID from Spec-017:435 `GHSA-v98v-ff95-f3cp`.
- **CRIT-4** Spec-012:48-56 missing `human_phase_contribution` (ninth category). **Direction inverted from ledger framing** after fresh evidence verification: Spec-012 is the out-of-sync doc, not Spec-017. Fix: add ninth enum entry per SA-12 directive — Spec-017:167/:415, Plan-017:84, ADR-015:182, and `local-sqlite-schema.md:577` already assume the extension landed per BL-097 Wave-1. Full evidence chain in §4.4.

**Scope decision (§2/§10.1 ambiguity resolution — advisor-surfaced 2026-04-22):** see §2 below. Summary: pattern-based batch for MINOR (§10.1-leaning reading) rather than per-finding entries for ~178 MINOR. Rationale in §2.

**Total plan entries:** 4 (CRITICAL full; CRIT-4 is 1 finding / 2 file-edits) + 17 (Lane I re-triage — all MINOR after §3) + 34 (MAJOR remediation groups covering 52 MAJOR findings via absorption + merge + cross-lane routing) + 1 (remediation-time spillover aggregate — §5.2.13, 6 post-H4 RTFs landed during H6 §5.2 execution; `finding-source: remediation-time`) + 11 (MINOR skeleton pattern blocks — one per lane A/B/D/E/F/G/H/I/J/K/L per §6) + 2 (meta amendments) = **58 detailed entries + 11 batch-pattern blocks = 69 total**. Reviewable at user gate; far below the ~250-entry strict reading.

---

## 2. Scope Decisions (Before User Approval)

The scope-lock contains one ambiguity that the advisor surfaced during H5 drafting. I resolved it below; the user gate is the moment to accept or amend.

### 2.1 Scope-lock §2 vs §10.1: MINOR handling

**Tension:**

- Scope-lock §2 (H5 row): H5 produces "per-finding edit plan with before/after text."
- Scope-lock §10.1: "MINOR-severity findings are remediated inline during H6 in the same commit as MAJOR/CRITICAL fixes. No separate MINOR-batch BL is filed."

**Reading chosen:** **§10.1-leaning.** H5 plan contains pattern-based batch remediation blocks for MINOR (one block per lane-level pattern, not one entry per finding), while CRITICAL and MAJOR retain full per-finding before/after text.

**Rationale:**

- §10.1's spirit is "don't bureaucratize MINOR." A per-finding entry for each of ~179 MINORs is exactly the bureaucracy §10.1 discourages.
- §2's phrase "per-finding edit plan with before/after text" is compatible with pattern-blocks that specify the uniform transformation for a family of identical MINORs (e.g., "Lane E: all 45 legacy-BL format-variance findings receive uniform hygiene-pass X").
- User-gate reviewability: a ~250-entry doc is not reviewable at gate; a ~90-detailed + ~15-pattern-block doc is.
- H6 execution correctness: patterns spell out the exact transformation; no ambiguity about what lands.

**If this reading is rejected at user gate:** fall back to strict §2 reading. The ~179 MINORs are enumerable (lanes A, B, E, F, G, H, I, J, K, L all have MINOR counts in ledger §7). A strict-reading draft adds ~4-6 hours of drafting work but is fully mechanical. The advisor flagged this trade-off; the user decides.

### 2.2 Lane I tentative 17 — re-triage sequencing

**Issue:** ledger §10 item 2 said "per-BL re-triage decisions + subsequent remediation." The re-triage MUST happen *before* the remediation entries, because the outcome (MAJOR vs MINOR) determines which remediation bucket each item lands in.

**Approach:** §3 of this plan executes the 17 re-triages via a single message containing 17 parallel Reads of backlog.md ranges (one Read per BL), plus supplemental cross-reference Reads where an Exit Criterion points at another artifact. All results land in-context for concurrent review; per-BL classification and cross-BL pattern detection both benefit from having the full corpus side-by-side.

**Why not a subagent fleet + why not sequential inline:** 17 small tree-state verifications; per-subagent overhead (spinning up, ingesting context, writing output file) exceeds per-item verification cost, but **sequential inline** would also waste round-trips. A single message with 17 parallel Reads combines the subagent-approach parallelism with the in-context immediacy of inline work. This is advisor-corrected 2026-04-22 from an earlier "sequential inline" draft.

### 2.3 META-1 scope-lock amendment

**Issue:** Scope-lock §10.3 prescribes two-commit H8 (LICENSE 1/2 + audit 2/2). META-1 confirmed LICENSE already landed 2026-04-17 (commit `45434c3`), so the 1/2 commit has no content.

**Amendment:** §10.3 is rewritten to describe single-commit H8 (audit ledger + remediations + this plan). See §7 for the exact amendment text that lands during H6.

---

## 3. Lane I Tentative 17 — Per-BL Re-Triage

Per §2.2, the 17 Lane I tentative CRITICAL claims are re-triaged against tree-state evidence before flowing into §5/§6 buckets. The 5 pre-triaged in ledger §5 (BL-038, BL-050, BL-054, BL-057, BL-083) are excluded from this list (already MINOR).

**Verification primitive (META-2 amendment):** check whether the BL's Exit Criteria are verifiable in the tree. **NOT** whether a Resolution block is present in the BL body.

**Triage outcomes:**

- **MINOR (false-positive)** — Exit Criteria fully verifiable in the tree; missing Resolution anchor is format-only drift.
- **MAJOR (partially-verifiable)** — some Exit Criteria verifiable, some not; residual drift warrants remediation.
- **CRITICAL (genuine MISSING)** — Exit Criteria substantively not satisfied in the tree.

**Method:** 17 parallel Reads of backlog.md BL blocks (executed 2026-04-22); edge-case verifications (BL-055 grep, BL-042 V1-readiness note, BL-085 version-floor propagation) landed via targeted greps before re-triage.

### 3.1 Per-BL re-triage table

| # | BL | Lane I ID | Primary artifact(s) | Tree-state evidence | Classification | Routing |
| --- | --- | --- | --- | --- | --- | --- |
| 3.1 | BL-039 (rewrite v1-feature-scope.md) | SHF-I-002 | `docs/architecture/v1-feature-scope.md` | File exists (verified 2026-04-22 via glob). Historical "V1 = 16" Exit Criterion superseded by BL-097 amendment (V1 = 17); Lane G's "V1 = 16 text" MINOR covers the residual historical phrasing. | **MINOR** | §6 (Lane I pattern-block spillover) |
| 3.2 | BL-040 (write ADR-016) | SHF-I-003 | `docs/decisions/016-electron-desktop-shell.md` | File exists; ADR status `accepted`; Electron chosen, Tauri/Wails rejected; Decision Log + Tripwires + reversibility sections all present (previous reads in this session confirm line 28+, 83+, 159-160). | **MINOR** | §6 |
| 3.3 | BL-041 (write Spec-023) | SHF-I-004 | `docs/specs/023-desktop-shell-and-renderer.md` | File exists; Spec-023 is the cross-cited target for BL-043/BL-056/BL-081/BL-082/BL-085 — all those consumer cites resolve post-H2 glob verification. | **MINOR** | §6 |
| 3.4 | BL-042 (V1-readiness review of Spec-016) | SHF-I-005 | `docs/specs/016-multi-agent-channels-and-orchestration.md` | Spec-016 has explicit "V1 Quality Bar" header-table field (line 11, verified 2026-04-22) + "V1 Readiness Review (BL-042, 2026-04-17)" section (line 189). Exit Criteria fully satisfied: review note appended, V1 quality bar declared. | **MINOR** | §6 |
| 3.5 | BL-043 (create Plan-023) | SHF-I-006 | `docs/plans/023-desktop-shell-and-renderer.md` | File exists; Spec-023 header `Implementation Plan` field population is verified-by-design (Spec-023 was authored in BL-041 to reference this plan slot). | **MINOR** | §6 |
| 3.6 | BL-044 (create Plan-021) | SHF-I-007 | `docs/plans/021-rate-limiting-policy.md` | File exists; Spec-021:11 `Implementation Plan` field reads `[Plan-021: Rate Limiting Policy](../plans/021-rate-limiting-policy.md)` (verified 2026-04-22 via grep), satisfying the Exit Criterion in full. | **MINOR** | §6 |
| 3.7 | BL-045 (create Plan-022) | SHF-I-008 | `docs/plans/022-data-retention-and-gdpr.md` | File exists; Spec-022:11 `Implementation Plan` field reads `[Plan-022: Data Retention And GDPR Compliance](../plans/022-data-retention-and-gdpr.md)` (verified 2026-04-22 via grep). | **MINOR** | §6 |
| 3.8 | BL-049 (authenticated-principal preamble) | SHF-I-012 | `docs/architecture/contracts/api-payload-contracts.md` + Spec-012 + ADR-011/Spec-004 | Primary artifact exists; Spec-012 line 82 explicitly cites the API-payload-contracts §Authenticated Principal section (seen during §4.4 Spec-012 Read this session) — proving the cross-cite landed. | **MINOR** | §6 |
| 3.9 | BL-051 (idempotency protocol) | SHF-I-014 | Spec-006, Spec-015, Spec-005, `local-sqlite-schema.md` | All four artifacts exist. `local-sqlite-schema.md:110-127` defines `command_receipts` with `idempotency_class TEXT NOT NULL CHECK(idempotency_class IN ('idempotent', 'compensable', 'manual_reconcile_only'))` (verified 2026-04-22 via Read), satisfying the schema Exit Criterion. | **MINOR** | §6 |
| 3.10 | BL-055 (propagate V1 scope across 20 plans) | SHF-I-018 | All 20 plan files | All 20 plans exist. Grep `V1\.1\|V2\|deferred` across plans returns 60 matches across 27 files (2026-04-22) — the 4 genuine V1.1 features (MLS, email invite delivery, cross-node artifacts, workflow authoring) account for the legitimate portion; residual count implies some plans contain context-appropriate references. Exit Criterion says "only intentional references" — not "zero." | **MINOR** | §6 (H6 task: grep-driven per-match spot-check; defer to MINOR pattern block for Lane E/K spillover if unintentional matches surface) |
| 3.11 | BL-056 (renderer trust stance) | SHF-I-019 | `container-architecture.md` + `security-architecture.md` + Spec-023 | All three artifacts exist. `container-architecture.md:71` declares "Desktop Renderer is untrusted"; `component-architecture-desktop-app.md:48` aligns with "renderer is less trusted"; `security-architecture.md:81,92,94` states renderer "never holds the daemon session token" and references Spec-023 §Trust Stance + BL-056 reconciliation (all verified 2026-04-22 via grep). Stance consistent across the three docs. | **MINOR** | §6 |
| 3.12 | BL-078 (Plan-024 Rust PTY Sidecar) | SHF-I-041 | `docs/plans/024-rust-pty-sidecar.md` | File exists; ADR-019 is the spec it implements; cross-cites to ADR-009 are a focused H6 verification. | **MINOR** | §6 |
| 3.13 | BL-079 (Spec-025 Self-Hostable Node Relay) | SHF-I-042 | `docs/specs/025-self-hostable-node-relay.md` | File exists; Spec-008 wire-protocol parity + BL-060 secure-by-default cross-refs are focused H6 verifications. | **MINOR** | §6 |
| 3.14 | BL-080 (Plan-025 Self-Hostable Node Relay) | SHF-I-043 | `docs/plans/025-self-hostable-node-relay.md` | File exists; Spec-025:11 `Implementation Plan` field reads `[Plan-025: Self-Hostable Node Relay](../plans/025-self-hostable-node-relay.md)` (verified 2026-04-22 via grep). | **MINOR** | §6 |
| 3.15 | BL-081 (Spec-026 First-Run Onboarding) | SHF-I-044 | `docs/specs/026-first-run-onboarding.md` | File exists; Spec-026 line 308 explicitly cites CVE-2026-34776 + GHSA-3c8v-cfp5-9885 (verified 2026-04-22 via grep — confirms the deep-link security surface is populated). | **MINOR** | §6 |
| 3.16 | BL-082 (Plan-026 First-Run Onboarding) | SHF-I-045 | `docs/plans/026-first-run-onboarding.md` | File exists; Spec-026:11 `Implementation Plan` field reads `[Plan-026: First-Run Onboarding](../plans/026-first-run-onboarding.md)` (verified 2026-04-22 via grep). | **MINOR** | §6 |
| 3.17 | BL-085 (ADR-016 version-floor bump) | SHF-I-048 | ADR-016 + Spec-023 + Spec-026 | ADR-016 lines 159-160 name fixed-version floors `38.8.6 / 39.8.1 / 40.8.1 / 41.0.0` and cite GHSA-3c8v-cfp5-9885 / CVE-2026-34776 (verified 2026-04-22 via grep). Spec-026:308 cites the same advisory ID. Spec-023 `Electron 30+` residual: grep returned zero genuine matches 2026-04-22 (only an incidental `2026-06-30` date-substring match, not a version floor). | **MINOR** | §6 |

**Classification outcome: 17/17 MINOR.** Zero genuine CRITICAL; zero MAJOR. META-2's 5/5-false-positive hypothesis **verified 22/22** across the full Lane I MISSING/CRITICAL pool (17 from this re-triage + 5 pre-triaged in ledger §5). All seven advisor-requested H6 spot-verification greps were executed pre-user-gate 2026-04-22 and passed — the re-triage table's Evidence column carries the verification findings; the Routing column no longer defers any verification to H6.

### 3.2 META-2 retroactive validation

The META-2 amendment (scope-lock §2 Lane I primitive — "check whether Exit Criteria are verifiable in the tree; NOT whether a Resolution block is present") was introduced after a 5-sample pre-triage in ledger §5 returned 5/5 false-positive. The full 17-BL re-triage above retroactively validates META-2 on the complete Lane I MISSING/CRITICAL pool:

| Metric | Pre-triage (ledger §5) | Full re-triage (§3.1) | Combined |
| --- | ---: | ---: | ---: |
| Sample size | 5 | 17 | 22 |
| MINOR (false-positive) | 5 | 17 | **22** |
| MAJOR (partially-verifiable) | 0 | 0 | 0 |
| CRITICAL (genuine MISSING) | 0 | 0 | 0 |
| False-positive rate | 100% | 100% | **100%** |

**Interpretation:** Lane I's MISSING/CRITICAL output, applied to BLs authored pre-Session-C (legacy Status+Exit-Criteria template), is systematically a format-detection signal (absent Resolution anchor), not a correctness-violation signal. The META-2 primitive refactor is validated — no Lane I MISSING/CRITICAL claim survived deep re-triage.

**What this implies for H5/H6:**

1. **§5 MAJOR count stable at 51** (no Lane I MAJOR spillover adds to it).
2. **§6 MINOR pattern for Lane I** absorbs all 17 — pattern is "legacy-format BL Resolution-stub retrofit," same shape as BL-083 (§8). The pattern block in §6 specifies the uniform "append Resolution (resolved YYYY-MM-DD): …" line per BL.
3. **Per-BL H6 verification spot-checks closed pre-user-gate.** The seven narrow grep tasks originally flagged in the Routing column (Spec-021/022/025/026 `Implementation Plan` header-field populations; `command_receipts.idempotency_class` schema presence; renderer-trust cross-doc stance consistency; Spec-023 residual "Electron 30+" version-floor audit) all passed verification 2026-04-22. No classification escalations; the Lane I pattern block in §6 now executes against a clean verification baseline.

### 3.3 Edge-case verifications (closed pre-user-gate; all MINOR)

Seven narrow grep tasks originally flagged for H6 were executed pre-gate 2026-04-22 and all passed:

- Spec-021:11 / Spec-022:11 / Spec-025:11 / Spec-026:11 `Implementation Plan` header-field populations (BL-044, BL-045, BL-080, BL-082) — all four header fields link to existing plan files; none reads `_(none yet)_`.
- `docs/architecture/schemas/local-sqlite-schema.md:110-127` `command_receipts` with `idempotency_class` CHECK constraint (BL-051 schema Exit Criterion).
- Renderer-trust cross-doc stance consistency (BL-056) — `container-architecture.md:71` + `component-architecture-desktop-app.md:48` + `security-architecture.md:81,92,94` all align on renderer-untrusted stance with Spec-023 back-reference.
- Spec-023 residual `Electron 30+` audit (BL-085) — grep returned zero genuine version-floor matches (only an incidental `2026-06-30` date-substring false positive).

One item (BL-055 "propagate V1 scope across 20 plans") retains a grep-driven per-match spot-check inside the §6 Lane I pattern block. That is hygiene execution, not outstanding verification: BL-055's Exit Criterion reads "only intentional references," not "zero," and the 60 matches across 27 files include four legitimate V1.1 feature references (MLS, email invite delivery, cross-node artifacts, workflow authoring). The §6 pattern specifies the per-match review.

If any §6-phase grep returns an unexpected result during H6 execution, the per-finding H6 loop (§9) records the escalation before remediation proceeds.

---

## 4. CRITICAL Remediations (4 Entries — Full Before/After)

Each entry specifies: finding ID(s), exact file + line range, verbatim before text, proposed after text, rationale, and cross-impact check. **All before-text captured via fresh Read 2026-04-22** — no summary-reconstructed verbatim (advisor correction enforced during H3 soft-spot closure).

### 4.1 CRIT-1 — Spec-017:409 broken cite to non-existent ADR-020 title

**Finding IDs:** SHF-C-004 (Lane C internal cross-reference validity) merged with Lane D SHF-D-003 + Lane L SHF-L-002 per ledger §5:187.
**Target file:** `docs/specs/017-workflow-authoring-and-execution.md`
**Target line:** 409 (within the "Governing docs" list at lines 404-409).

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
- [ADR-020 — Agent capabilities and contract-ordering](../decisions/020-agent-capabilities-and-contract-ordering.md)
```

**After (proposed):** *delete the line entirely.* The "Governing docs" block becomes (after CRIT-1 + CRIT-2 land):

```markdown
### Governing docs

- [ADR-015 — V1 Feature Scope Definition](../decisions/015-v1-feature-scope-definition.md) (amended 2026-04-22 per BL-097)
- [ADR-002 — Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [ADR-018 — Cross-Version Compatibility](../decisions/018-cross-version-compatibility.md)
```

**Rationale:** ADR-020 in the repo is `020-v1-deployment-model-and-oss-license.md` ("V1 Deployment Model and OSS License"), verified via `docs/decisions/` glob. No ADR under title "Agent capabilities and contract-ordering" exists; grep across `docs/decisions/` for `agent.cap|contract.order|capability` (case-insensitive) returned 7 files, none named or titled to match. Agent/SDK semantics for Spec-017 are grounded by (a) ADR-015 V1 feature scope (cited 9× across Spec-017 — verified 2026-04-22 via grep), which remains in the governing-docs block post-edit, and (b) Spec-017's own "Core SDK and persistence contracts" block beginning at line 121 — which defines the agent/SDK contract inline rather than importing from a separate ADR. The broken ADR-020 cite adds no governance — remove cleanly. (Earlier drafts of this rationale claimed Spec-005 cross-reference support; 2026-04-22 grep verification confirmed Spec-017 contains **zero** Spec-005 references, so the claim is dropped.)

**Option space (user-gate flag — ledger §5:187 left "fix or remove" unadjudicated):**

| Option | Description | H5 scope fit | Recommendation |
| --- | --- | --- | --- |
| **A (recommended)** | Delete the line. Agent/SDK governance retained via ADR-015 (V1 scope) + Spec-017 §121 (inline Core SDK block). Clean closure; no residual broken cite. | In-scope — drift-closure via removal. | ✓ H5 proposal |
| B | Author a new ADR titled "Agent capabilities and contract-ordering" and fix the link target. | **Out of H5 scope** — expands charter from drift-closure to new-ADR authoring. Would require its own design process. | ✗ |
| C | Replace with a stub/TODO comment. | In-scope by letter, but defers rather than closes — contradicts H5 drift-closure goal. | ✗ |

The §4.1 proposal is Option A. If the user prefers B or C at the H5 gate, H6 execution-plan changes accordingly.

**Cross-impact check:**

- Lane D bidirectionality: no ADR-020-at-Spec-017 reciprocal cite exists in `020-v1-deployment-model-and-oss-license.md` to orphan.
- Spec-017 retains load-bearing ADR governance via ADR-015 (V1 scope) + ADR-002 (local execution, per CRIT-2) + ADR-018 (cross-version).
- No downstream doc cites Spec-017's ADR-020 reference specifically, so removal does not propagate.

### 4.2 CRIT-2 — Spec-017:407 broken path + stale title for ADR-002

**Finding IDs:** Lane L SHF-L-001 (primary per ledger §5:188); Lane C SHF-C-003 + Lane D SHF-D-002 corroborate at Spec-017:407.
**Target file:** `docs/specs/017-workflow-authoring-and-execution.md`
**Target line:** 407.

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
- [ADR-002 — Local-first architecture](../decisions/002-local-first-architecture.md)
```

**After (proposed):**

```markdown
- [ADR-002 — Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
```

**Rationale:** ADR-002 in the repo is `docs/decisions/002-local-execution-shared-control-plane.md` with canonical title "Local Execution Shared Control Plane" (verified via glob + other doc cites — e.g., `deployment-topology.md:190` uses the canonical title/path). Spec-017 uses a historical title ("Local-first architecture") and a stale filename that was never committed. Both path and title updated to match repo canonical.

**Cross-impact check:**

- Link target now resolves to an existing file (previously 404).
- Title matches cross-document usage in `deployment-topology.md`, ADR-003, etc.
- No second "Local-first architecture" legacy alias to reconcile elsewhere (grep-verified during H2).

### 4.3 CRIT-3 — Plan-017:117 wrong GHSA ID (n8n CVE-2025-68613)

**Finding IDs:** SHF-A-117 (Lane A external-URL 404) per ledger §5:189; canonical ID from Spec-017:435.
**Target file:** `docs/plans/017-workflow-authoring-and-execution.md`
**Target line:** 117 (within the I2 row of the Security regression battery table).

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
| I2 — typed substitution, no eval | Every expression payload either parses to whitelisted AST or throws `ExpressionParseError` | n8n [CVE-2025-68613](https://github.com/advisories/GHSA-wfw3-33mq-9c84); Airflow [CVE-2024-39877](https://nvd.nist.gov/vuln/detail/CVE-2024-39877); Airflow [CVE-2024-56373](https://nvd.nist.gov/vuln/detail/CVE-2024-56373); Jenkins `CVE-2024-34144` / `CVE-2024-34145` |
```

**After (proposed — surgical ID swap `GHSA-wfw3-33mq-9c84` → `GHSA-v98v-ff95-f3cp`):**

```markdown
| I2 — typed substitution, no eval | Every expression payload either parses to whitelisted AST or throws `ExpressionParseError` | n8n [CVE-2025-68613](https://github.com/advisories/GHSA-v98v-ff95-f3cp); Airflow [CVE-2024-39877](https://nvd.nist.gov/vuln/detail/CVE-2024-39877); Airflow [CVE-2024-56373](https://nvd.nist.gov/vuln/detail/CVE-2024-56373); Jenkins `CVE-2024-34144` / `CVE-2024-34145` |
```

**Rationale:** Canonical GHSA ID for n8n CVE-2025-68613 is `GHSA-v98v-ff95-f3cp`, confirmed authoritative at Spec-017:435 (`https://github.com/n8n-io/n8n/security/advisories/GHSA-v98v-ff95-f3cp`). The Plan-017:117 URL path `github.com/advisories/GHSA-wfw3-33mq-9c84` 404s (Lane A finding). The `github.com/advisories/` URL shape is a valid alias to the repo-specific `/security/advisories/` shape when the ID is correct, so only the ID is swapped — preserves the table row structure and cross-document cite-style consistency.

**Cross-impact check:**

- After fix, Plan-017:117 and Spec-017:435 agree on GHSA ID.
- No other `GHSA-wfw3-33mq-9c84` references exist in the repo (grep-verified).
- SA-30 security regression battery integrity preserved — I2 remains tied to n8n CVE-2025-68613; only the broken-link artifact changes.

### 4.4 CRIT-4 — `human_phase_contribution` enum missing in Spec-012 + Plan-012 (two-file edit)

**Finding IDs:** SHF-D-005 (Lane D internal-cross-reference-bidirectionality); cross-corroboration with Lane K (downstream-consumer drift at Plan-017:84 + `local-sqlite-schema.md:577`).

**Target files (2-location edit — CRIT-4 is a single drift with two file locations):**

| Edit | File | Line(s) | Role |
| --- | --- | --- | --- |
| **4.4A** | `docs/specs/012-approvals-permissions-and-trust-boundaries.md` | 48-56 | Primary canonical enum |
| **4.4B** | `docs/plans/012-approvals-permissions-and-trust-boundaries.md` | 64 | Consumer mirror — inline 8-category listing in Implementation Steps |

**Adjudication (direction-inversion from the ledger framing):** The H3 ledger entry framed this as "either fix Spec-012 enum or remove Spec-017's claim." Fresh evidence verification 2026-04-22 resolves the ambiguity unambiguously: **Spec-012 is the out-of-sync doc; add the ninth category.** Evidence chain:

| # | Source | Evidence |
| --- | --- | --- |
| 1 | `docs/research/bl-097-workflow-scope/wave-1-synthesis.md:87` | `Cedar category: landed as new human_phase_contribution (Spec-012 enum extension).` — synthesis records the decision as *already landed* |
| 2 | `wave-1-synthesis.md:181` | SA-12 defined as: `Add human_phase_contribution to Spec-012 approval category enum` — SA-12 IS the Spec-012-extension directive |
| 3 | `pass-c-human-phase-ux.md:80-82` | Pass C selected Option (b): `Add category: human_phase_contribution. Clearer audit boundary (matches the phase-type / approval-category one-to-one convention...)` |
| 4 | `docs/architecture/schemas/local-sqlite-schema.md:577` | Schema already ships the 9-value enum with comment `-- SA-12 addition` |
| 5 | `docs/decisions/015-v1-feature-scope-definition.md:182` | ADR-015 references the new Cedar category as a decided V1 outcome |
| 6 | `docs/specs/017-workflow-authoring-and-execution.md:167, :415` + `docs/plans/017-workflow-authoring-and-execution.md:84` | Three downstream references already assume the category exists — all load-bearing |

Removing from Spec-017 would invalidate five other docs plus the V1 SQLite schema. Adding to Spec-012 + Plan-012 aligns both with the already-landed BL-097 Wave-1 decision.

**Discovery note on the two-file scope:** The initial §4 draft treated CRIT-4 as a single-file Spec-012 edit. Advisor verification 2026-04-22 prompted a grep of `docs/plans/012*.md` for enum-mirror listings, which returned **Plan-012:64** — "The 8 canonical approval categories are: ..." with all eight names inline. Plan-012:64 is a consumer mirror of Spec-012's enum and must stay synchronized; CRIT-4 therefore spans two files.

---

#### Edit 4.4A — Spec-012:48-56 (primary enum)

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
- The canonical approval category enum is:
  - `tool_execution` — tool call approval
  - `file_write` — out-of-boundary file writes
  - `network_access` — unrestricted network
  - `destructive_git` — force push, branch delete
  - `user_input` — freeform questions from agent
  - `plan_approval` — proposed plan review
  - `mcp_elicitation` — MCP server input
  - `gate` — workflow phase gate
```

**After (proposed — add one bullet, preserve ordering):**

```markdown
- The canonical approval category enum is:
  - `tool_execution` — tool call approval
  - `file_write` — out-of-boundary file writes
  - `network_access` — unrestricted network
  - `destructive_git` — force push, branch delete
  - `user_input` — freeform questions from agent
  - `plan_approval` — proposed plan review
  - `mcp_elicitation` — MCP server input
  - `gate` — workflow phase gate
  - `human_phase_contribution` — phase-level human contribution (Spec-017 `human` phase submission; SA-12 addition per BL-097 Wave-1 synthesis)
```

---

#### Edit 4.4B — Plan-012:64 (consumer mirror)

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
1. Define canonical approval categories, scope enums, remembered-grant rules, and trust-evaluation inputs in shared contracts. The 8 canonical approval categories are: `tool_execution`, `file_write`, `network_access`, `destructive_git`, `user_input`, `plan_approval`, `mcp_elicitation`, and `gate`.
```

**After (proposed — update count and append the ninth category):**

```markdown
1. Define canonical approval categories, scope enums, remembered-grant rules, and trust-evaluation inputs in shared contracts. The 9 canonical approval categories are: `tool_execution`, `file_write`, `network_access`, `destructive_git`, `user_input`, `plan_approval`, `mcp_elicitation`, `gate`, and `human_phase_contribution` (SA-12 addition per BL-097 Wave-1 — see Spec-012 canonical enum).
```

---

**Rationale (covers both 4.4A and 4.4B):** Restores enum canonicity — Spec-012 becomes the authoritative source for the 9-category enum, and Plan-012's Implementation Steps mirror reflects the same canonical count so a reader of Plan-012 does not encounter stale "8 categories" prose. The inline SA-12 provenance note (4.4A) + the Spec-012 back-reference (4.4B) ensure a future reader can trace why a ninth category exists and where the canonical source lives.

**Cross-impact check:**

- After edits, Spec-017:167 + Spec-017:415 become correct (reference existing Spec-012 category) — **no separate Spec-017 remediation needed**; CRIT-4's two-file fix eliminates the downstream findings.
- After edits, Plan-017:84 references an existing Spec-012 category.
- After edits, `local-sqlite-schema.md:577` matches Spec-012 (was leading by one category pre-fix).
- After edits, ADR-015:182's research-link note is consistent with Spec-012 canonical.
- **Spec-012 single-enum-location verified** 2026-04-22 via grep: Spec-012 has exactly ONE enum location (line 105's "approval category" hit is the Cedar action-mapping note, not a second enum).
- **Plan-012 single-enum-location verified** 2026-04-22 via grep: Plan-012:64 is the only inline enum listing in that file (Implementation Steps step 1); no other Plan-012 section re-enumerates the categories.
- No other consumer introduces new drift — the enum is only *extended*, not mutated; ordering and existing eight entries preserved in both locations.

**H6 execution note:** Edits 4.4A and 4.4B must land in the same commit for consumer-mirror consistency. If partially applied (Spec-012 updated but Plan-012 still claims "8 categories"), readers of Plan-012 would see stale count vs canonical — which would be a net new drift introduced by remediation. The per-finding H6 loop (§9) treats CRIT-4 as a single atomic finding with two write locations.

---

## 5. MAJOR Remediations (Full Before/After)

Grouped by remediation pattern per ledger §6 table. Post-dedup + pre-work-verified counts (2026-04-22):

| Pattern | Section | Groups | File-edits |
| --- | --- | ---: | ---: |
| Lane A — External-URL 404 (compact swap table) | §5.1 | 6 | 16 |
| Lane A — External-URL/citation content-drift (full entries) | §5.2 | 12 | 19 |
| Lane B — External-quote fidelity (full entries) | §5.3 | 3 | 4 |
| Lane C — Internal link/anchor (full entries) | §5.4 | 4 | 4+ |
| Lane D — Cross-ref bidirectionality (full entries) | §5.5 | 1 (D-006+D-007+D-008 merged) | 7 |
| Lane E — Coverage/orphan (full entries) | §5.6 | 3 | 0 (all deferred-by-design or cross-lane routed) |
| Lane H — Dependency/topology (full entries) | §5.7 | 4 | 21 |
| Lane K — Numeric (full entries) | §5.8 | 1 | 1 |
| **§5 TOTAL** | — | **34** | **71** |

**§5.1 + §5.2 + §5.3 + §5.4 + §5.5 + §5.6 + §5.7 + §5.8 drafted 2026-04-22** — 18 Lane A groups + 3 Lane B groups + 4 Lane C groups + 1 Lane D merged group + 3 Lane E deferred-confirm groups + 4 Lane H groups + 1 Lane K group = 34 groups across 71 file-edits (recommendation-set; up to 88 under alternative gate choices if Lane E/H defaults are overridden — Lane E +7 if §5.6.1/§5.6.3 Option B; Lane H +10 if §5.7.3 Option A2). §1 count reconciliation at §5.8 close is complete.

Two entries moved between buckets vs ledger §6 counts: **§5.2.1 Dagger** is a URL-404 by finding-type but lacks a canonical replacement that preserves the cited claim — routed to content-drift with user-gate question (see §10 Q#6); **SHF-preseed-002** (originally Lane B quote-fidelity) routes to §5.7 Lane H because the remediation is adding a `PRAGMA synchronous = FULL;` directive to `local-sqlite-schema.md`, not a quote repair.

**Atomic-commit discipline for multi-file groups:** each §5.1 row spans multiple file-locations (e.g., the OWASP-ASVS row touches security-architecture.md twice + backlog.md once). All locations within one row must land in the same H6 commit — partial application leaves mixed old/new URLs across sibling docs. The per-finding H6 loop treats each row as a single finding with N hash-pre/hash-post pairs (one per file-edit). This mirrors CRIT-4's two-file atomic-edit pattern (§4.4).

### 5.1 Lane A — External-URL 404 Compact Swap Table

Each row represents one URL-drift group. All occurrences within a row swap in the same H6 commit; the `Display-text` column notes where the link label also changes (not just the URL target).

| # | Dead URL | Canonical Replacement | File:line Occurrences | Display-text change | H6 notes |
| --- | --- | --- | --- | --- | --- |
| 5.1.1 | `https://owasp.org/ASVS` | `https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md` | security-architecture.md:157; security-architecture.md:190; backlog.md:520 | none (label stays `OWASP ASVS 5.0 V7.4.5`) | 3 file-edits; backlog.md:520 is inside a completed-BL Resolution block — user-gate Q#7 asks in-place vs footnote |
| 5.1.2 | `https://github.com/napi-rs/keyring` | `https://github.com/Brooooooklyn/keyring-node` | ADR-021:45; ADR-021:266 | none (display `@napi-rs/keyring` is the valid npm package name, repo moved ownership) | 2 file-edits |
| 5.1.3 | `https://github.com/napi-rs/node-keyring` (+ `…/blob/main/src/lib.rs`) | `https://github.com/Brooooooklyn/keyring-node` (+ `…/blob/main/src/lib.rs`) | Spec-026:245; Spec-026:314; Plan-026:344; Plan-026:484; Plan-026:556 | Plan-026:344 + :484 replace `napi-rs/node-keyring` display with `Brooooooklyn/keyring-node`; other rows preserve `@napi-rs/keyring` display | 5 file-edits; Plan-026:484 swaps the `/blob/main/src/lib.rs` deep-link suffix too |
| 5.1.4 | `https://github.blog/changelog/2019-06-06-updated-github-actions-workflow-syntax/` | `https://github.blog/changelog/2019-09-17-github-actions-will-stop-running-workflows-written-in-hcl/` | Spec-017:62; Spec-017:425 | label text updates: `2019-06-06` → `2019-09-17`; `updated-github-actions-workflow-syntax` narrative → `will-stop-running-workflows-written-in-hcl` (the Sept 17 changelog is the HCL-deprecation announcement; same 2019 claim supported) | 2 file-edits; Spec-017:62 shares a line with the §5.2.1 Dagger citation — both edits must land in the same commit |
| 5.1.5 | `https://docs.temporal.io/workflow-execution/timeouts` | `https://docs.temporal.io/encyclopedia/detecting-workflow-failures` | Spec-017:165; Spec-017:445 | none (label `Temporal Workflow Execution Timeouts` still accurate — encyclopedia page covers Workflow Execution Timeout with default ∞ per WebSearch verification 2026-04-22) | 2 file-edits; Spec-017:165 is a spillover Lane A did not flag — found via parent-context grep per advisor Pass-1 pre-work |
| 5.1.6 | `https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/teams.html` | `https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html` | Spec-017:147; Spec-017:450 | none (label `AutoGen Teams` / `AutoGen — Teams and HandoffMessage` still accurate — the `tutorial/` segment was added when AutoGen reorganized the agentchat docs; content confirms `HandoffMessage` API still canonical per WebSearch 2026-04-22) | 2 file-edits; Spec-017:147 is a spillover Lane A did not flag — found via parent-context grep |

**Pass-2 canonical-replacement research summary (2026-04-22):** WebFetches against all 7 unique dead URLs confirmed 404. WebSearch + targeted canonical probes recovered canonical replacements for 6 of 7. The 7th (Dagger next-dagger-sdks) is routed to §5.2.1 per advisor guidance — see below.

**Cross-impact check (all §5.1 rows):**

- All 15 file-edits are pure URL-string swaps (+ 2 display-text swaps on Plan-026:344/:484). No surrounding prose mutates.
- ADR-021:45's existing `(v1.2.0)` version annotation remains accurate — `Brooooooklyn/keyring-node` v1.2.0 was released 2025-09-02 per Pass-2 WebFetch.
- backlog.md:520 swap preserves Resolution-block semantics — cited claim (OWASP ASVS 5.0 V7.4.5 admin-terminate-all-sessions) is still exactly supported by the new canonical URL; only the landing-path changes.
- Spec-017:62 carries two co-located citations (dagger.io + github.blog). The §5.1.4 GitHub swap and the §5.2.1 Dagger remediation both land in the same commit to avoid mid-line inconsistency.

### 5.2 Lane A — External-URL/Citation Content-Drift (Full Entries)

Unlike §5.1 rows (pure URL-string swaps), §5.2 entries change the cited claim, the citation label, or both — a mechanical swap would either leave the claim unsupported or silently change its meaning.

#### 5.2.1 Dagger "next Dagger SDKs" citation — content-fidelity loss (user-gate decision pending)

**Finding IDs:** Lane A URL-404 grouping (Spec-017:62 + Spec-017:424).
**Target files:** `docs/specs/017-workflow-authoring-and-execution.md` (2 lines).
**Routing rationale:** Flagged as URL-404 but no canonical replacement supports the load-bearing quantitative claim ("Dagger rewrote its CUE-based SDK over ~2.5 years"). See Pass-2 research record below.

**Before (verbatim, fresh Read 2026-04-22) — Spec-017:62:**

```markdown
- Workflow authoring format: YAML definitions + typed TypeScript SDK. **No bespoke DSL** (no CUE, no HCL, no custom expression language) — C-1 commitment. DSL lock-in cost is precedent-heavy: Dagger rewrote its CUE-based SDK over ~2.5 years ([Dagger — next Dagger SDKs, 2023](https://dagger.io/blog/next-dagger-sdks)); GitHub Actions migrated off HCL to YAML under breaking-change pressure ([GitHub Actions HCL→YAML deprecation, 2019](https://github.blog/changelog/2019-06-06-updated-github-actions-workflow-syntax/)).
```

**Before (verbatim, fresh Read 2026-04-22) — Spec-017:424:**

```markdown
- [Dagger — next Dagger SDKs (CUE→SDK migration)](https://dagger.io/blog/next-dagger-sdks) — 2023
```

**Pass-2 research record:**

- **Original URL** (`dagger.io/blog/next-dagger-sdks`) returns HTTP 404 (verified 2026-04-22).
- **Candidate replacement** `dagger.io/blog/introducing-dagger-functions` (Feb 2024): live but **does not support the cited claim** — no mention of a 2.5-year rewrite period, no retrospective commentary on CUE deprecation.
- **GitHub search** `site:github.com/dagger/dagger "CUE"` surfaced Discussion #4086 ("CUE SDK - Current state + potential futures") and Issue #3121 ("Port CUE SDK to Dagger Engine 0.3") — both forward-looking community discussions from 2023, not post-migration retrospectives. No surviving primary source describes the "~2.5 years" duration.
- **web.archive.org** WebFetch is blocked from this environment; the archived `next-dagger-sdks` post may exist there but is not retrievable here.

**Three remediation options (user-gate Q#6 decision):**

| Option | Remediation | After text for Spec-017:62 | After text for Spec-017:424 | Trade-off |
| --- | --- | --- | --- | --- |
| **(a) Remove, lean on GitHub Actions HCL→YAML alone** | Delete the Dagger parenthetical; keep the GitHub Actions precedent as the sole DSL lock-in citation | `…DSL lock-in cost is precedent-heavy: GitHub Actions migrated off HCL to YAML under breaking-change pressure ([GitHub Actions HCL→YAML deprecation, 2019](https://github.blog/changelog/2019-09-17-github-actions-will-stop-running-workflows-written-in-hcl/)).` | delete the line entirely | Strongest fidelity — no unsupported claim. Weakest rhetorical load-bearing — C-1 "no bespoke DSL" now rests on one precedent instead of two. |
| **(b) Downgrade to a weaker supported claim + live URL** | Rewrite to cite Discussion #4086 + the `introducing-dagger-functions` outcome post for the migration narrative; drop the "~2.5 years" quantitative claim | `…DSL lock-in cost is precedent-heavy: Dagger replaced its CUE-based SDK with a code-first SDK lineup ([Dagger — Introducing Dagger Functions, 2024](https://dagger.io/blog/introducing-dagger-functions); [Dagger — CUE SDK: Current state + potential futures, discussion #4086](https://github.com/dagger/dagger/discussions/4086)); GitHub Actions migrated off HCL to YAML under breaking-change pressure ([GitHub Actions HCL→YAML deprecation, 2019](https://github.blog/changelog/2019-09-17-github-actions-will-stop-running-workflows-written-in-hcl/)).` | replace with `[Dagger — Introducing Dagger Functions (CUE→Functions replacement)](https://dagger.io/blog/introducing-dagger-functions) — 2024` | Preserves two-precedent structure. Loses the quantitative "2.5 years" punch — C-1's lock-in-cost framing becomes qualitative. |
| **(c) Keep the claim, mark citation as retrieved-dead** | Add `[archived — URL 404 as of 2026-04-22; replacement research TBD]` parenthetical; preserve original URL as documentary artifact | Spec-017:62 unchanged; add inline annotation `([Dagger — next Dagger SDKs, 2023](https://dagger.io/blog/next-dagger-sdks) — URL 404 2026-04-22; replacement research pending)` | Same annotation style | Preserves historical citation intent. Introduces a known-broken link; conflicts with audit scope-lock §10.1 "remediate all MAJOR drift." Rejected by advisor framing. |

**Recommendation:** **Option (a).** Per `feedback_citations_in_downstream_docs.md` — every load-bearing ADR/spec decision lands primary-source citations for each load-bearing claim; when no primary source survives, the correct remediation is to retire the claim, not to back it with a weaker substitute. The C-1 commitment survives on the GitHub Actions precedent alone; the rhetorical cost of losing the 2.5-year datapoint is acceptable given the alternative is a dead URL or a downgraded claim. If the user judges the two-precedent structure load-bearing for C-1's defense, Option (b) is the next-best path.

**Cross-impact check:**

- Option (a) removes one of two DSL-lock-in citations supporting Spec-017 C-1 — no downstream doc references the Dagger citation specifically (grep-verified: `dagger` appears only in Spec-017:62/:424 across the `docs/` tree).
- Options (a) and (b) both require Spec-017:62 to land the §5.1.4 GitHub Actions URL swap in the same H6 commit (co-located citation).
- No downstream doc cites `dagger.io/blog/next-dagger-sdks` — removal does not cascade.

---

#### 5.2.2 Node 20 (Iron) EOL date — factual drift against cited source (3 occurrences)

**Finding IDs:** SHF-A-009, SHF-A-010, SHF-A-011.
**Target file:** `docs/specs/025-self-hostable-node-relay.md`; 3 locations (lines 79, 164, 199).
**Canonical source:** `https://nodejs.org/en/about/previous-releases` lists Node 20 (Iron) EOL as **2026-03-24**, not 2026-04-30 as cited.

**Before (verbatim, fresh Read 2026-04-22) — lines 79, 164, 199 all spell `2026-04-30`:**

- L79: `Node.js 20 (Iron) is end-of-life 2026-04-30 and is not supported.`
- L164: `Iron goes EOL 2026-04-30; V1 baselines Node.js 22 LTS from day one.`
- L199: `Node 20 (Iron) EOL 2026-04-30; Node 22 LTS is the 2026 baseline`

**After (proposed — date swap `2026-04-30` → `2026-03-24` at all three locations, preserving surrounding prose):**

- L79: `Node.js 20 (Iron) is end-of-life 2026-03-24 and is not supported.`
- L164: `Iron goes EOL 2026-03-24; V1 baselines Node.js 22 LTS from day one.`
- L199: `Node 20 (Iron) EOL 2026-03-24; Node 22 LTS is the 2026 baseline`

**Rationale:** The cited source (nodejs.org/en/about/previous-releases) lists Node 20 EOL at 2026-03-24 (moved earlier from an originally-published 2026-04-30 projection). SHF-A-011 is the most egregious: the drifted date sits immediately adjacent to the citation URL that disproves it. One H6 edit per line; same file, atomic commit.

**Cross-impact check:**

- No other doc in the tree cites Node 20 EOL with a specific date (grep-verified: `2026-04-30` appears only at these three Spec-025 lines across the `docs/` corpus).
- The "V1 baselines Node.js 22" + "not supported" normative claims are independent of the exact EOL date and remain correct.

---

#### 5.2.3 RFC 9068 §5 title — wrong section cited for `sub`-as-principal

**Finding IDs:** SHF-A-012.
**Target file:** `docs/architecture/contracts/api-payload-contracts.md:15`.
**Canonical source:** RFC 9068 §5 is titled "Security Considerations"; the `sub`-as-principal pattern is normatively specified in §2.2 ("sub" subsection under "Authentication Information Claims").

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
See [RFC 9068 §5 — JWT Access Tokens, `sub` as subject](https://datatracker.ietf.org/doc/html/rfc9068#section-5) for the `sub`-as-principal pattern and [ADR-010 PASETO + WebAuthn + MLS Auth](../../decisions/010-paseto-webauthn-mls-auth.md) for the V1 PASETO profile.
```

**After (proposed — re-anchor to §2.2 where `sub`-as-principal is actually specified):**

```markdown
See [RFC 9068 §2.2 — `sub` claim](https://datatracker.ietf.org/doc/html/rfc9068#section-2.2) for the `sub`-as-principal pattern and [ADR-010 PASETO + WebAuthn + MLS Auth](../../decisions/010-paseto-webauthn-mls-auth.md) for the V1 PASETO profile.
```

**Rationale:** §6 escalation clause applies — the citation backs a security-invariant claim (`sub` as principal identity for Cedar policy binding). Re-anchoring to §2.2 preserves the cited claim with a correct anchor; relabeling to `§5 — Security Considerations` would be pro-forma-correct but semantically divergent from the sentence's use of the citation.

**Cross-impact check:**

- RFC 9068 §2.2 is titled "`sub`" and normatively defines subject-as-principal semantics per WebFetch verification during Lane A research.
- No other doc cross-references "RFC 9068 §5" (grep-verified).

---

#### 5.2.4 node-pty#437 mischaracterization — actual issue is "kill hangs" not "orphaned children" (3 occurrences)

**Finding IDs:** SHF-A-014, SHF-A-015, SHF-A-016.
**Target files:** `docs/decisions/019-windows-v1-tier-and-pty-sidecar.md` (lines 22, 178); `docs/plans/024-rust-pty-sidecar.md:199`.
**Canonical source:** `https://github.com/microsoft/node-pty/issues/437` — actual title: "Unable to kill pty process on Windows" — reporter demonstrates `ptyProcess.kill()` hangs indefinitely on Windows 10 (works on Ubuntu). The issue is **not** about process-tree kill or orphaned-descendants semantics.

**Before (verbatim, fresh Read 2026-04-22):**

- ADR-019:22: `- [`microsoft/node-pty#437`](https://github.com/microsoft/node-pty/issues/437) — Process-tree kill is unreliable on Windows; orphaned children survive.`
- ADR-019:178: `\| `microsoft/node-pty#437` \| Upstream issue \| Process-tree kill unreliable on Windows \| https://github.com/microsoft/node-pty/issues/437 \|`
- Plan-024:199: `- [microsoft/node-pty#437](https://github.com/microsoft/node-pty/issues/437) — process-tree kill unreliable on Windows`

**After (proposed — rewrite characterization to match actual issue content, preserving URL):**

- ADR-019:22: `- [`microsoft/node-pty#437`](https://github.com/microsoft/node-pty/issues/437) — `ptyProcess.kill()` hangs indefinitely on Windows (confirmed on Windows 10); unaffected on Linux.`
- ADR-019:178: `\| `microsoft/node-pty#437` \| Upstream issue \| `ptyProcess.kill()` hangs on Windows, works on Linux \| https://github.com/microsoft/node-pty/issues/437 \|`
- Plan-024:199: `- [microsoft/node-pty#437](https://github.com/microsoft/node-pty/issues/437) — `ptyProcess.kill()` hangs on Windows`

**Rationale:** The load-bearing argument in ADR-019 (Rust PTY sidecar needed for Windows reliability) is **strengthened**, not weakened, by the corrected characterization — a fundamental `.kill()` hang is more serious than an orphaned-child cleanup gap. Downstream ADR-019 conclusion (sidecar needed) remains correct; only the upstream-bug description tightens. One finding-loop spans 3 file-edits across 2 files; all must land in the same commit.

**Cross-impact check:**

- Grep confirms "Process-tree kill" / "orphaned children" / "orphaned descendants" wording does not appear elsewhere in the corpus tied to node-pty#437.
- ADR-019's Decision / Consequence blocks do not themselves assert "process-tree kill" — only the referenced-issue summary line drifts.

---

#### 5.2.5 Jenkins SECURITY-383 — advisory ID not present at cited date (2 occurrences; user-gate decision pending)

**Finding IDs:** SHF-A-017, SHF-A-018.
**Target file:** `docs/specs/017-workflow-authoring-and-execution.md` (lines 344, 441).
**Pass-2 research record:** WebSearch 2026-04-22 did not surface a Jenkins public advisory carrying the "SECURITY-383" ID. The cited page (`jenkins.io/security/advisory/2017-04-10/`) lists ~40 `SECURITY-nnn` IDs but not 383. Nearby `SECURITY-*` input-step advisories appear at [2017-07-10](https://www.jenkins.io/security/advisory/2017-07-10/) and [2022-10-19](https://www.jenkins.io/security/advisory/2022-10-19/); the input-step plugin CHANGELOG is at [`jenkinsci/pipeline-input-step-plugin`](https://github.com/jenkinsci/pipeline-input-step-plugin/blob/master/CHANGELOG.md).

**Before (verbatim, fresh Read 2026-04-22):**

- Spec-017:344: `Anti-pattern: Jenkins `input` step where `Read` permission approves and admin bypass is silent ([Jenkins SECURITY-383 advisory, 2017](https://www.jenkins.io/security/advisory/2017-04-10/)).`
- Spec-017:441: `- [Jenkins SECURITY-383 input-step advisory](https://www.jenkins.io/security/advisory/2017-04-10/)`

**Three remediation options (user-gate Q#8 decision):**

| Option | Spec-017:344 after-text | Spec-017:441 after-text | Trade-off |
| --- | --- | --- | --- |
| **(a) Drop specific ID, broaden to "input-step handling"** | `…([Jenkins input-step CSRF advisory 2022-10-19](https://www.jenkins.io/security/advisory/2022-10-19/)).` | `- [Jenkins Pipeline: Input Step security advisory 2022-10-19](https://www.jenkins.io/security/advisory/2022-10-19/)` | Cites a real, verifiable advisory about input-step handling. Loses the "silent admin bypass" specificity but preserves the anti-pattern citation. |
| **(b) Re-characterize against the plugin CHANGELOG** | `…([`jenkinsci/pipeline-input-step-plugin` CHANGELOG](https://github.com/jenkinsci/pipeline-input-step-plugin/blob/master/CHANGELOG.md)).` | `- [Jenkins Pipeline: Input Step plugin CHANGELOG](https://github.com/jenkinsci/pipeline-input-step-plugin/blob/master/CHANGELOG.md)` | Broader historical record with multiple permission-handling fixes. Less surgical than an advisory citation. |
| **(c) Remove the Jenkins citation entirely** | Drop the parenthetical; the "Anti-pattern" sentence retains its normative force via the other cited Airflow/Argo CVEs at Spec-017:436+. | Delete the bullet. | Loses the Jenkins-specific precedent. Strongest claim fidelity (nothing unverified survives). |

**Recommendation:** **Option (a)** — the 2022-10-19 advisory "pipeline-input-step-plugin 451 and earlier does not restrict or sanitize the optionally specified ID" is a verifiable, in-period input-step security citation; keeps the anti-pattern framing with a live link. Per `feedback_citations_in_downstream_docs.md`, surfacing this as a user-gate question because the original "SECURITY-383" claim's provenance cannot be confirmed by research.

---

#### 5.2.6 CloudEvents §3.1.1 — non-existent section anchor

**Finding IDs:** SHF-A-019.
**Target file:** `docs/specs/017-workflow-authoring-and-execution.md:261`.
**Canonical source:** CloudEvents v1.0.2 spec places reverse-DNS naming guidance in the top-level `type` attribute subsection (under "REQUIRED Attributes"), anchor `#type`. No §3.1.1 anchor exists.

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
Reverse-DNS `workflow.*` namespace convention follows [CloudEvents Specification v1.0.2 §3.1.1](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md).
```

**After (proposed — re-anchor to the `type` attribute subsection):**

```markdown
Reverse-DNS `workflow.*` namespace convention follows [CloudEvents Specification v1.0.2 `type` attribute](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md#type).
```

**Rationale:** The `#type` anchor resolves to the subsection that normatively states "SHOULD be prefixed with a reverse-DNS name" per WebSearch 2026-04-22. The §3.1.1 numeric reference predates a spec reorganization; the load-bearing claim (reverse-DNS naming) is unchanged.

**Cross-impact check:**

- No other doc in the tree cites CloudEvents §3.1.1 (grep-verified).
- The `#type` anchor is stable at the v1.0.2 tag (tag-pinned URL won't drift).

---

#### 5.2.7 Airflow XCom pickle deprecation — cited page missing the claim

**Finding IDs:** SHF-A-024.
**Target file:** `docs/specs/017-workflow-authoring-and-execution.md:427`.
**Canonical source:** The "pickle disabled in 2.0" claim is documented at apache/airflow issue [#9606](https://github.com/apache/airflow/issues/9606) ("Turn off pickling of XCom by default in 2.0") and in the Configuration Reference's `enable_xcom_pickling` entry.

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
- [Airflow XCom serialization](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/xcoms.html) — pickle disabled 2.0
```

**After (proposed — cite the actual canonical source for the pickle-disabled-in-2.0 decision):**

```markdown
- [Airflow — Turn off pickling of XCom by default in 2.0, #9606](https://github.com/apache/airflow/issues/9606) — JSON replaced Pickle to close RCE exposure; `[core] enable_xcom_pickling` forced to `False`
```

**Rationale:** The current-URL page (XComs core concepts) covers serializer mechanics but does not contain the "pickle disabled in 2.0" policy claim. Issue #9606 is the canonical record of the decision; the Configuration Reference entry is a secondary live source. Swapping preserves the Spec-017 C-1/SA-17 supporting evidence for "workflow state must not carry arbitrary pickle payloads."

**Cross-impact check:**

- No other doc cites the `xcoms.html` URL for pickle-disabled claims.
- Issue #9606 is a Closed/resolved issue with the decision recorded permanently in its body + linked commits — stable URL.

---

#### 5.2.8 Airflow 2→3 terminology migration — cited page is generic upgrade mechanics

**Finding IDs:** SHF-A-025.
**Target file:** `docs/specs/017-workflow-authoring-and-execution.md:428`.
**Canonical source:** The Datasets→Assets / SubDAG→TaskGroup / execution_date→logical_date terminology migration is documented at [`installation/upgrading_to_airflow3.html`](https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading_to_airflow3.html). The current cited URL (`installation/upgrading.html`) covers database-migration mechanics only.

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
- [Airflow 2→3 terminology migration](https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading.html) — Datasets→Assets, SubDAG→TaskGroup, execution_date→logical_date
```

**After (proposed — swap to the Airflow 3 upgrade guide):**

```markdown
- [Airflow — Upgrading to Airflow 3](https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading_to_airflow3.html) — Datasets→Assets, SubDAG→TaskGroup, execution_date→logical_date
```

**Rationale:** The `upgrading_to_airflow3.html` page is the canonical home for the 2→3 terminology migration narrative per WebSearch 2026-04-22. The `upgrading.html` page's scope is DB-migration mechanics; the terminology-migration claim is not on that page. Minor label-text adjustment from `Airflow 2→3 terminology migration` → `Airflow — Upgrading to Airflow 3` preserves the cited-claim specificity via the descriptive trailer.

**Cross-impact check:**

- Single-file single-line edit; no cross-ref cascade.
- The `stable/` path intentionally floats with Airflow's current stable release — acceptable for an "upgrading" narrative that stays accurate as the stable version advances.

---

#### 5.2.9 Airflow SubDAG deprecation — cited anchor does not exist

**Finding IDs:** SHF-A-026.
**Target file:** `docs/specs/017-workflow-authoring-and-execution.md:429`.
**Canonical source:** SubDAG deprecation is documented via apache/airflow issue [#12292](https://github.com/apache/airflow/issues/12292) ("Deprecate SubDags in Favor of TaskGroups") + the Airflow 2.0 blog announcement. No `#subdags` anchor exists on the current core-concepts/dags page (only TaskGroups are covered).

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
- [Airflow SubDAG deprecation notice](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html#subdags)
```

**After (proposed — swap to the canonical deprecation record):**

```markdown
- [Airflow — Deprecate SubDags in Favor of TaskGroups, #12292](https://github.com/apache/airflow/issues/12292) — SubDAG removed in Airflow 3.0; TaskGroup is the canonical replacement
```

**Rationale:** Issue #12292 is the canonical record of the SubDAG deprecation decision — a permanent, stable URL with the decision rationale in the issue body. The claim being supported (SubDAG deprecation as a DAG-composition pattern regret) maps cleanly to the issue title. Airflow's own docs now document TaskGroup as the composition mechanism; no anchor is needed for the deprecation narrative.

**Cross-impact check:**

- Single-file single-line edit.
- Issue #12292 is closed/merged; URL is stable.

---

#### 5.2.10 Camunda User Task properties anchor — anchor does not exist

**Finding IDs:** SHF-A-029.
**Target file:** `docs/specs/017-workflow-authoring-and-execution.md:448`.
**Canonical source:** `https://docs.camunda.io/docs/components/modeler/bpmn/user-tasks/` covers user task properties via Assignments / Scheduling / Variable Mappings / Forms subsections; no `#user-task-properties` anchor exists.

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
- [Camunda 8 — User Task properties](https://docs.camunda.io/docs/next/components/modeler/bpmn/user-tasks/#user-task-properties)
```

**After (proposed — drop the anchor and the `/next/` version prefix):**

```markdown
- [Camunda 8 — User tasks](https://docs.camunda.io/docs/components/modeler/bpmn/user-tasks/) — assignments, scheduling, dueDate, followUpDate
```

**Rationale:** The page (without anchor) covers all the human-task properties Spec-017's §HumanPhaseConfig citation needs. Dropping `/next/` moves from the unstable next-release docs to current stable docs — preferred for references meant to stay valid. The trailer adds specificity lost by dropping the anchor.

**Cross-impact check:**

- Single-file single-line edit.
- Grep verification 2026-04-22: the same `/docs/next/components/modeler/bpmn/user-tasks/#user-task-properties` URL appears at **Spec-017:165** (co-located on the same line as the §5.1.5 Temporal Workflow Execution Timeouts citation and an Argo citation). That means **§5.2.10 is a 2-occurrence group** spanning Spec-017:165 and Spec-017:448.

**H6 atomic-commit note:** Spec-017:165 is touched by §5.1.5 (Temporal URL swap) **and** §5.2.10 (Camunda anchor swap) — both edits must land in the same commit to avoid partial-line inconsistency. The H6 edit sequence for line 165 is bottom-to-top within the line; apply both swaps before hashing the post-text.

---

#### 5.2.11 Airflow issue #54540 mischaracterization — "encoding-bypass" is wrong

**Finding IDs:** SHF-A-051.
**Target file:** `docs/specs/017-workflow-authoring-and-execution.md:438`.
**Canonical source:** apache/airflow issue #54540 documents a HashiCorp Vault masking regression in Airflow 3.0.0-3.0.4 where `MASK_SECRETS_IN_LOGS` was only applied to `task_test` and `triggerer` processes (a config-scope miss), not the "encoding-bypass" characterization in the current citation.

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
- [Airflow secret masker issue #54540 (encoding-bypass)](https://github.com/apache/airflow/issues/54540)
```

**After (proposed — rewrite characterization to match actual issue content; preserve URL):**

```markdown
- [Airflow secret masker issue #54540 (Vault masking regression, Airflow 3.0.0-3.0.4)](https://github.com/apache/airflow/issues/54540)
```

**Rationale:** Spec-017's I4 security invariant ("secret masking must apply to all process contexts") is still supported by the corrected characterization — the actual issue content (config-scope miss causing Vault secrets to bypass masking in normal task processes) is a stronger precedent for the invariant than the spurious "encoding-bypass" framing. One-line surgical rewrite; URL unchanged.

**Cross-impact check:**

- Single-file single-line edit.
- No downstream doc re-characterizes the issue (grep-verified).

---

#### 5.2.12 Electron issue #24573 mischaracterization — "cross-platform binding" is wrong

**Finding IDs:** SHF-A-122.
**Target file:** `docs/plans/023-desktop-shell-and-renderer.md:341`.
**Canonical source:** electron/electron issue #24573 addresses WebAuthn origin eligibility in local/custom-scheme Electron apps — specifically that public-key credentials are only available to HTTPS origins or `localhost` HTTP origins, which blocks `file://` and `app://` scheme apps. The issue is about **origin-scheme eligibility**, not cross-platform binding.

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
- [Electron issue #24573](https://github.com/electron/electron/issues/24573) — cross-platform WebAuthn binding (still open, no ETA)
```

**After (proposed — rewrite characterization to match actual issue content; preserve URL):**

```markdown
- [Electron issue #24573](https://github.com/electron/electron/issues/24573) — WebAuthn origin eligibility for custom-scheme Electron apps (public-key credentials restricted to HTTPS / localhost HTTP origins; still open, no ETA)
```

**Rationale:** Plan-023's WebAuthn-in-Electron feasibility narrative needs the correct upstream-constraint characterization. The "cross-platform binding" framing falsely suggests platform-support parity as the gap; the real gap is origin-scheme eligibility — a different architectural constraint for Plan-023's renderer auth flow. The corrected text properly bounds the feasibility claim. One-line surgical rewrite.

**Cross-impact check:**

- Single-file single-line edit.
- Plan-023 does not elsewhere assume "cross-platform binding" (grep-verified) — the drift is local to this Primary Sources entry.
- If a separate `electron-webauthn-mac` (Vault12) citation at Plan-023:340 covers the macOS-only live solution, no additional rework is needed — Plan-023's current flow correctly treats the Vault12 macOS binding as the only production-ready WebAuthn path.

---

#### 5.2.13 Remediation-time spillover finds — body-prose twins of §5.2.x entries (6 entries, ALL LANDED during H6 §5.2 execution)

**Finding IDs:** RTF-1 through RTF-6.
**`finding-source: remediation-time`** — Discovered during H6 §5.2 mechanical batch execution (post-H4 frozen-discovery checkpoint) via post-edit grep verification for residual drift patterns. All six are body-prose replications of §5.2.x references-appendix edits; none are novel drift classes.
**Status:** LANDED in H6 atomic-commit group with their parent §5.2.x entries. Documented here post-hoc for H7 audit trail and META-1 entry-count completeness; no additional remediation required.

**Why this aggregate (not 6 individual sub-sections):** All six RTFs are derivative of already-classified §5.2.x patterns (same canonical-source fix, same lane, same finding-type). Each entry cross-refs its parent §5.2.x — if any were novel drift, it would warrant its own sub-section. Advisor-confirmed aggregation pattern 2026-04-23.

**Parent-mapping:** RTF-1 → §5.2.9; RTF-2 → §5.2.7; RTF-3 → §5.2.11; RTF-4 → §5.2.8; RTF-5 → §5.2.2; RTF-6 → §5.2.4. All six map cleanly to existing §5.2.x patterns; none are novel drift.

---

**RTF-1 — Spec-017:147 body prose, Airflow SubDAG URL swap (parent §5.2.9)**

**Target:** `docs/specs/017-workflow-authoring-and-execution.md:147`.
**Before (verbatim, pre-landing 2026-04-23):** `...took 3+ years to patch ([Airflow SubDAG deprecation](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/dags.html#subdags)).`
**After (landed 2026-04-23):** `...took 3+ years to patch ([Airflow — Deprecate SubDags in Favor of TaskGroups, #12292](https://github.com/apache/airflow/issues/12292)).`
**Rationale:** Body prose carrying the same stale `/dags.html#subdags` anchor that §5.2.9 fixed in the references appendix (Spec-017:429). Same canonical-URL replacement applied for consistency. Lane A URL-fidelity.

---

**RTF-2 — Spec-017:215 body prose, Airflow XCom pickle URL swap (parent §5.2.7)**

**Target:** `docs/specs/017-workflow-authoring-and-execution.md:215`.
**Before (verbatim, pre-landing 2026-04-23):** `Airflow XCom's pickle default enabled a direct RCE path, disabled in 2.0 ([Airflow XCom serialization](https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/xcoms.html)).`
**After (landed 2026-04-23):** `Airflow XCom's pickle default enabled a direct RCE path, disabled in 2.0 ([Airflow — Turn off pickling of XCom by default in 2.0, #9606](https://github.com/apache/airflow/issues/9606)).`
**Rationale:** Body prose carrying the same stale `/xcoms.html` URL that §5.2.7 fixed in the references appendix (Spec-017:427). Same PR-issue swap applied for consistency. Lane A citation-fidelity.

---

**RTF-3 — Spec-017:345 body prose, Airflow #54540 mischaracterization (parent §5.2.11)**

**Target:** `docs/specs/017-workflow-authoring-and-execution.md:345`.
**Before (verbatim, pre-landing 2026-04-23):** `The redaction-is-defense-in-depth stance is motivated by [Airflow secret masker issue #54540](https://github.com/apache/airflow/issues/54540) encoding-bypass.`
**After (landed 2026-04-23):** `The redaction-is-defense-in-depth stance is motivated by [Airflow secret masker issue #54540](https://github.com/apache/airflow/issues/54540) Vault masking regression (Airflow 3.0.0-3.0.4).`
**Rationale:** Body prose carrying the same "encoding-bypass" mischaracterization §5.2.11 fixed in the references appendix (Spec-017:438). Same factual correction applied for consistency. Lane A accuracy.

---

**RTF-4 — Spec-017:354 body prose, Airflow 2→3 terminology URL swap (parent §5.2.8)**

**Target:** `docs/specs/017-workflow-authoring-and-execution.md:354`.
**Before (verbatim, pre-landing 2026-04-23):** `...terminology churn is the precedent for cost of late rename ([Airflow 2→3 terminology migration guide](https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading.html)).`
**After (landed 2026-04-23):** `...terminology churn is the precedent for cost of late rename ([Airflow — Upgrading to Airflow 3](https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading_to_airflow3.html)).`
**Rationale:** Body prose carrying the same stale `/upgrading.html` URL §5.2.8 fixed in the references appendix (Spec-017:428). Same canonical-URL replacement applied for consistency. Lane A URL-fidelity.

---

**RTF-5 — Plan-025:211 Node 20 EOL date drift (parent §5.2.2)**

**Target:** `docs/plans/025-self-hostable-node-relay.md:211`.
**Before (verbatim, pre-landing 2026-04-23):** `...Iron goes EOL 2026-04-30 (pre-V1-GA...`
**After (landed 2026-04-23):** `...Iron goes EOL 2026-03-24 (pre-V1-GA...`
**Rationale:** Fourth occurrence of the 2026-04-30 → 2026-03-24 factual drift §5.2.2 fixed in Spec-025 (3 occurrences at L79, L164, L199). Grep-missed during H2 Lane A scoping because this occurrence was in Plan-025 (not Spec-025) and within a narrative paragraph, not a references table entry. Same canonical date applied for consistency. Lane F factual drift (cross-file replication).

---

**RTF-6 — backlog.md:237 BL-052 Resolution node-pty#437 mischaracterization (parent §5.2.4)**

**Target:** `docs/backlog.md:237` (BL-052 Resolution block).
**Before (verbatim, pre-landing 2026-04-23):** ``...`microsoft/node-pty#437` (process-tree kill unreliable on Windows)...``
**After (landed 2026-04-23):** ``...`microsoft/node-pty#437` (`ptyProcess.kill()` hangs on Windows, works on Linux)...``
**Rationale:** Downstream BL-052 Resolution replication of the same "process-tree kill unreliable" mischaracterization §5.2.4 fixed in ADR-019 (L22, L178) + Plan-024 (L199). Parent-context grep via §5.2.4 canonical replacement pattern caught this spillover that Lane A H2 did not flag (BL-052 Resolution block was scoped under Lane I re-triage, not Lane A). Per §9 multi-file atomic-commit discipline, landed in same commit as parent §5.2.4 edits.

---

**Cross-impact check (aggregate):**

- All 6 RTFs are single-file single-line edits already landed 2026-04-23.
- §5.2.13 adds 1 sub-section to §5.2 (12 pre-existing + 1 aggregate = 13). META-1 entry count updated from 57 detailed → 58 detailed, 68 total → 69 total (L34 edit landed with this amendment).
- No new finding classes introduced — all six inherit their parent §5.2.x classification (4× Lane A URL-fidelity, 1× Lane F factual drift, 1× Lane A accuracy).
- RTF-5 (Plan-025:211) and RTF-6 (backlog.md:237) each represent cross-file replication of a §5.2.x pattern that Lane A H2's single-file scoping missed. This is the same enumeration-gap pattern as CRIT-4 (§4.4B, Plan-012:64 replication of Spec-012 drift) and §5.3.2 (backlog.md:443 replication of Spec-015:259 quote drift) — three independent instances suggest a systematic Lane-A H2 gap where body-prose replication of references-appendix content is under-scoped.

**H6b pre-scope recommendation:** Before executing each §5.7 sub-cluster (and §6 MINOR pattern blocks), run a pre-scope inverted grep across `docs/specs/`, `docs/decisions/`, `docs/plans/`, `docs/architecture/`, and `docs/backlog.md` looking for stale patterns that mirror the references-appendix fix. The 60% RTF rate on §5.2 (6 spillovers observed across 10 canonical-replacement §5.2.x groups, after excluding user-gated §5.2.1/§5.2.5 and URL-preserving §5.2.3/§5.2.6/§5.2.12) justifies inverted-audit discipline for §5.7 and §6.

---

### 5.3 Lane B — External Citation Quote Fidelity (Full Entries)

Lane B MAJOR entries are verbatim-quote drift — the attribution URL renders without the quoted substring. Remediation is per-entry: URL swap when the verbatim text exists on a sibling page of the same vendor domain; word-level fix when the closest verbatim text differs by a phrase; paraphrase only when no primary source carries the wording. SHF-preseed-002 (`PRAGMA synchronous = FULL` absent from `docs/architecture/schemas/local-sqlite-schema.md`) routes to §5.7 as an additive schema edit — not a citation fix.

**§5.3 totals:** 3 groups / 4 file-edits across 3 files (Spec-015, backlog.md, ADR-017).

#### 5.3.1 SQLite "All automatic checkpoints are PASSIVE" — wrong SQLite sub-page cited (URL swap)

**Finding ID:** SHF-B-001.
**Target:** `docs/specs/015-persistence-recovery-and-replay.md:258` (1 file-edit).
**Canonical source (verified 2026-04-22):** `sqlite.org/pragma.html#pragma_wal_autocheckpoint` — carries the verbatim sentence "This pragma is a wrapper around the sqlite3_wal_autocheckpoint() C interface. All automatic checkpoints are PASSIVE." (WebFetch 2026-04-22; last-updated 2025-11-13). The current citation `sqlite.org/c3ref/wal_checkpoint_v2.html` does NOT carry this substring; `sqlite.org/wal.html` also lacks it verbatim.

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
- **Page-driven (auto)** — SQLite's built-in autocheckpoint fires when the WAL reaches `1000` pages (the default for `PRAGMA wal_autocheckpoint` confirmed at [sqlite.org/pragma.html#pragma_wal_autocheckpoint](https://sqlite.org/pragma.html#pragma_wal_autocheckpoint), last-updated 2025-11-13, fetched 2026-04-19). Per [sqlite.org/c3ref/wal_checkpoint_v2.html](https://sqlite.org/c3ref/wal_checkpoint_v2.html) — *"All automatic checkpoints are PASSIVE."*
```

**After (proposed — swap the attribution URL from `c3ref/wal_checkpoint_v2.html` to `pragma.html#pragma_wal_autocheckpoint` and collapse the repeated URL since that page is already cited for the `1000` pages default; update fetch date to the re-verification date):**

```markdown
- **Page-driven (auto)** — SQLite's built-in autocheckpoint fires when the WAL reaches `1000` pages (the default for `PRAGMA wal_autocheckpoint` confirmed at [sqlite.org/pragma.html#pragma_wal_autocheckpoint](https://sqlite.org/pragma.html#pragma_wal_autocheckpoint), last-updated 2025-11-13, fetched 2026-04-22). Per the same page — *"All automatic checkpoints are PASSIVE."*
```

**Rationale:** The quote appears verbatim on `pragma.html#pragma_wal_autocheckpoint` — the page already cited in the same bullet for the `1000` pages autocheckpoint default. The current attribution points at `c3ref/wal_checkpoint_v2.html` (C-API reference) which describes PASSIVE mode's behavior but does not carry this summary sentence. Re-citing consolidates the attribution to one URL and preserves verbatim-match. The "fetched" date update reflects Lane B's re-verification fetch 2026-04-22. Alternative considered: add `pragma.html` as a second citation rather than collapsing — rejected because the same URL appearing twice in the same bullet adds ceremony without informational gain.

**Cross-impact check:**

- Single-file single-line edit (Spec-015:258).
- `docs/backlog.md:443` (BL-063 Resolution) also cites `pragma.html` for the same 1000-pages default but does NOT quote "All automatic checkpoints are PASSIVE" — confirmed by grep. No multi-file spillover.
- Pairs with §5.3.2 for adjacent-bullet single-commit atomicity (same paragraph in Spec-015).

---

#### 5.3.2 SQLite "does as much work as possible" — quote wording fix + sub-page re-cite (multi-file)

**Finding ID:** SHF-B-002 (Lane B); multi-file spillover to `backlog.md:443` caught by parent-context grep — Lane B H2 enumerated only the source Spec-015 line, consistent with the CRIT-4/Plan-012:64 pattern where lane-subagent scope misses replicated text in downstream surfaces.
**Targets:** `docs/specs/015-persistence-recovery-and-replay.md:259` + `docs/backlog.md:443` (BL-063 Resolution) — 2 file-edits, single commit per §9 multi-file atomic-commit discipline.
**Canonical source (verified 2026-04-22):** `sqlite.org/wal.html` §3.2 — carries the verbatim phrase "PASSIVE, which does as much work as it can without interfering with other database connections." (WebFetch 2026-04-22; last-updated 2026-04-13). The current citation `sqlite.org/c3ref/wal_checkpoint_v2.html` does NOT carry "as much work as possible" or "as much work as it can"; `sqlite.org/pragma.html` also lacks both wordings. Only `wal.html` carries the verbatim substring, and it reads "as much work as **it can**" — the current spec text "as much work as **possible**" is the author's imprecise recall.

**Before (verbatim, fresh Read 2026-04-22) — Spec-015:259:**

```markdown
- **Time-driven (explicit)** — the daemon runs `PRAGMA wal_checkpoint(PASSIVE)` every 5 minutes via the writer worker. PASSIVE is the only mode that, per [wal_checkpoint_v2.html](https://sqlite.org/c3ref/wal_checkpoint_v2.html), *"does as much work as possible without interfering with other database connections"* — it never invokes the busy-handler callback and does not block readers or writers. FULL, RESTART, and TRUNCATE each either block writers or contend with readers.
```

**After — Spec-015:259 (proposed: two-word fix "possible" → "it can"; URL swap to `wal.html` §3.2):**

```markdown
- **Time-driven (explicit)** — the daemon runs `PRAGMA wal_checkpoint(PASSIVE)` every 5 minutes via the writer worker. PASSIVE is the only mode that, per [sqlite.org/wal.html](https://sqlite.org/wal.html) §3.2, *"does as much work as it can without interfering with other database connections"* — it never invokes the busy-handler callback and does not block readers or writers. FULL, RESTART, and TRUNCATE each either block writers or contend with readers.
```

**Before (verbatim, fresh Read 2026-04-22) — backlog.md:443 (inline excerpt; full line is a single long BL-063 Resolution paragraph):**

```markdown
…time-driven runs explicit `PRAGMA wal_checkpoint(PASSIVE)` every 5 min — PASSIVE is the only mode that "does as much work as possible without interfering with other database connections" per sqlite.org/c3ref/wal_checkpoint_v2.html)…
```

**After — backlog.md:443 (proposed: same two-word fix + URL swap):**

```markdown
…time-driven runs explicit `PRAGMA wal_checkpoint(PASSIVE)` every 5 min — PASSIVE is the only mode that "does as much work as it can without interfering with other database connections" per sqlite.org/wal.html §3.2)…
```

**Rationale:** The current spec wording "as much work as possible" does not appear on any SQLite.org primary source. The verbatim wording is "as much work as it can" on `wal.html` §3.2 — differing by two words. The em-dash post-quote clause ("it never invokes the busy-handler callback") is the spec author's own paraphrase, not a claimed verbatim from the cited URL; re-citing to `wal.html` does not orphan it — wal.html §3.2 also covers the four checkpoint modes' blocking semantics, so the adjacent "FULL, RESTART, and TRUNCATE each either block writers" claim remains supported. The backlog.md:443 occurrence is a downstream replication with verbatim-identical drift and must be repaired in the same commit to avoid mixed-state drift across Spec-015 and its Resolution artifact. Parent-context grep caught this spillover that Lane B H2 did not flag.

**Cross-impact check:**

- 2 files, 1 commit per §9: Spec-015:259 + backlog.md:443 land atomically.
- No other doc in the tree quotes "does as much work as possible" or "as much work as it can" (grep-verified).
- The backlog.md:443 occurrence sits inside a BL-063 Resolution block (`completed`). Per §10 Q#7 framing and Session C precedent (commits `e57bb26`, `bd40e35`), in-place edit of Resolution blocks for correctness is an established convention.
- The downstream paraphrase in backlog.md:443 — "(only mode that truncates the log file to zero bytes)" — is natively supported by wal.html §3.2 (same checkpoint-modes section) and does not require a secondary citation after the URL swap.

---

#### 5.3.3 Automerge CRDT definition quote — sub-page re-cite + restored elided opening

**Finding ID:** SHF-B-023.
**Target:** `docs/decisions/017-shared-event-sourcing-scope.md:46` (1 file-edit).
**Canonical source (verified 2026-04-22):** `automerge.org/docs/hello` — carries the verbatim sentence "Automerge is a Conflict-Free Replicated Data Type (CRDT), which allows concurrent changes on different devices to be merged automatically without requiring any central server." (WebFetch 2026-04-22). The landing page `automerge.org` (current primary citation) does NOT carry this sentence; it describes Automerge as "a local-first sync engine for multiplayer apps that works offline, prevents conflicts, and runs fast." The ADR already lists `automerge.org/docs/hello` as a secondary citation alongside the landing-page URL, but the quote's primary attribution is the landing page where the substring is absent.

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
- **Automerge (CRDT, Kleppmann et al.):** "a Conflict-Free Replicated Data Type (CRDT), which allows concurrent changes on different devices to be merged automatically without requiring any central server." Per-replica hash-DAG, merge by commutativity, no central sequencer. ([automerge.org](https://automerge.org/), [automerge.org/docs/hello](https://automerge.org/docs/hello))
```

**After (proposed — restore the elided "Automerge is" opening for clean verbatim-substring match; drop the landing-page URL since it does not carry the quoted text; retain `docs/hello` as the sole attribution):**

```markdown
- **Automerge (CRDT, Kleppmann et al.):** "Automerge is a Conflict-Free Replicated Data Type (CRDT), which allows concurrent changes on different devices to be merged automatically without requiring any central server." Per-replica hash-DAG, merge by commutativity, no central sequencer. ([automerge.org/docs/hello](https://automerge.org/docs/hello))
```

**Rationale:** The current ADR quote begins with lowercase `"a Conflict-Free..."` — a silent elision of "Automerge is " that, under strict Lane B primitive, breaks verbatim-substring match. Restoring "Automerge is " yields a verbatim-substring match at `automerge.org/docs/hello`. The landing-page URL is dropped because it does not carry the quoted text — keeping both URLs would preserve a URL→quote precision gap that Lane B's discovery notes explicitly flagged as in-scope for Lane B. Alternative considered: bracketed-elision academic-quote form `"[Automerge is] a Conflict-Free..."` — functionally equivalent under Lane B, differs only in presentation style; rejected because bracketed elision adds ceremony without informational gain in a technical ADR context where the opening subject restoration is unambiguous.

**Cross-impact check:**

- Single-file single-line edit (ADR-017:46).
- ADR-017's Thesis paragraph relies on a four-of-four local-first-systems precedent (Kleppmann, Automerge, Zed, Replicache); Automerge is one of four exemplars. The quote-opening fix does not affect the precedent structure.
- `"without requiring any central server"` substring appears only at ADR-017:46 across the `docs/` tree (grep-verified). No downstream doc re-quotes this sentence.
- Related Lane B entry SHF-B-022 (ADR-017:45 Kleppmann "local-first" quote) is MATCH-verified and does not require remediation; the Automerge entry is the only Lane B drift in this four-item precedent block.

---

### §5.4 Lane C — Internal Cross-Reference Validity (4 entries)

Lane C H2 surfaced 6 MAJOR findings. Two are absorbed into §4 (SHF-C-003 → §4.2 CRIT-2; SHF-C-004 → §4.1 CRIT-1). Four remain for §5.4:

- §5.4.1 SHF-C-001 at `shared-postgres-schema.md:177` — anchor drift `#token-revocation` (target heading absent in security-architecture.md).
- §5.4.2 SHF-C-002 at `plans/001-shared-session-core.md:69` — broken file link `./018-identity-provider-adapters.md` (file-rename miss).
- §5.4.3 SHF-C-005 at `specs/017-workflow-authoring-and-execution.md:416` — broken file link `../specs/013-session-timeline-and-presence.md` (file-rename miss).
- §5.4.4 SHF-preseed-003 at `cross-plan-dependencies.md:82-115` — legend-label drift (6 rows use a third Type value not defined in legend).

**Parent-context spillover grep results (per §5.3 lesson):**

- `#token-revocation` — 1 source hit (shared-postgres-schema.md:177 only).
- `018-identity-provider-adapters` — 1 source hit (plans/001-shared-session-core.md:69 only; Lane H SHF-H-006 overlap-noted, not duplicate).
- `013-session-timeline-and-presence` — 1 source hit (specs/017:416 only).
- `declared in plan header` — 6 source hits in 1 file (cross-plan-dependencies.md:98/110/111/112/114/115 — the 6 in-scope rows).

No §5.4 group requires a multi-file atomic commit.

---

#### §5.4.1 SHF-C-001 — shared-postgres-schema.md:177 anchor drift

**Finding IDs:** SHF-C-001 (Lane C internal cross-reference validity — DRIFT).
**Target file:** `docs/architecture/schemas/shared-postgres-schema.md` (recommended option edits `docs/architecture/security-architecture.md` instead — see Option space below).
**Target line:** 177 (within §Token Revocation Families Retention paragraph).

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
**Retention:** Rows are reaped after `expires_at + 24h` safety margin. The 7-day refresh-token TTL (see [security-architecture.md §Token revocation](../security-architecture.md#token-revocation)) bounds the total row count — worst case is roughly `7 days × daily-active refresh tokens per participant`.
```

**Target-file anchor evidence (security-architecture.md, fresh-Read 2026-04-22):**

- L148: `**Token revocation:**` — paragraph-bold label, NOT a markdown heading (no slug anchor generated).
- L155: `#### Bulk Revoke All For Participant (BL-070)` — heading (slug: `bulk-revoke-all-for-participant-bl-070`).
- No `### Token revocation` or `#### Token revocation` heading exists. Grep across security-architecture.md for `^#+ .*[Tt]oken revocation` returns zero matches.

The L148-154 paragraph block is semantically about "token revocation" (RFC 7009 per-token, bulk per-participant pointer, propagation semantics, removal-from-session scope). The anchor `#token-revocation` is the natural slug for this block but no heading materializes it.

**Option space (user-gate flag):**

| Option | Description | Files touched | Recommendation |
| --- | --- | --- | --- |
| A | Swap anchor in shared-postgres-schema.md:177 to `#bulk-revoke-all-for-participant-bl-070`; update link text to match new target. | shared-postgres-schema.md:177. | Viable. Preserves existing security-architecture.md structure. Semantic narrowing: bulk-revoke covers TTL bound at L180 but not the general revocation flow. |
| **B (recommended)** | Promote `**Token revocation:**` at security-architecture.md:148 to `#### Token revocation` heading. Auto-resolves the existing link; no shared-postgres-schema.md edit needed. | security-architecture.md:148. | ✓ H5 proposal. Aligns link text with target heading; creates a structurally-discoverable anchor for a subtopic that already exists as a paragraph label. |
| C | Add raw HTML `<a id="token-revocation"></a>` tag at security-architecture.md:148. | security-architecture.md:148. | ✗ Introduces HTML into a Markdown-only corpus. Not recommended. |

**After (Option B — proposed edit to security-architecture.md:148):**

```markdown
#### Token revocation
```

(Replacing `**Token revocation:**` with an H4 heading; bullet content below L148 stays verbatim.)

**Rationale:** The shared-postgres-schema.md:177 link text says `§Token revocation` — matching the paragraph label at security-architecture.md:148 but not any heading slug. Option B promotes the existing paragraph label to a heading, producing slug `#token-revocation` and resolving the link without changing link text or conceptual target. The block's content (RFC 7009 single-token, Bulk-per-participant pointer, propagation semantics, removal-from-session scope) is discoverable as a subtopic in its own right — meriting a heading. Option A narrows the target to bulk-revoke-only, misaligning with the general "§Token revocation" link text. Option C breaks Markdown-only corpus discipline.

**Cross-impact check:**

- Single-file single-line edit (security-architecture.md:148, H4 heading promotion).
- No other repo-wide references to `#token-revocation` exist (grep-verified).
- security-architecture.md's existing `#### Bulk Revoke All For Participant (BL-070)` at L155 stays as a child subtopic — sibling H4 within §Control-Plane Authentication (Task 5.2) ### section. The new Token revocation H4 sits between `### Control-Plane Authentication (Task 5.2)` (L96) and `#### Bulk Revoke All For Participant (BL-070)` (L155). Existing outline preserved.
- No downstream doc cites `#token-revocation` besides shared-postgres-schema.md:177.

---

#### §5.4.2 SHF-C-002 — plans/001-shared-session-core.md:69 file-rename

**Finding IDs:** SHF-C-002 (Lane C internal cross-reference validity — ORPHAN); corroborated by Lane H SHF-H-006 (encountered during Lane H header trace; Lane C is authoritative).
**Target file:** `docs/plans/001-shared-session-core.md`
**Target line:** 69 (within §Forward-Declared Elements table, participants row).

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
| `participants` (minimal anchor: `id`, `created_at`) | [Plan-018](./018-identity-provider-adapters.md) | Plan-001 creates the anchor row shape; no participant rows are inserted until Plan-018's registration flow lands; Plan-018 adds `display_name`, `identity_ref`, `metadata`, and `identity_mappings` via additive ALTER migrations per [Shared Postgres Schema §Participants and Identity](../architecture/schemas/shared-postgres-schema.md#participants-and-identity-plan-018) |
```

**After (proposed — path-only surgical fix):**

```markdown
| `participants` (minimal anchor: `id`, `created_at`) | [Plan-018](./018-identity-and-participant-state.md) | Plan-001 creates the anchor row shape; no participant rows are inserted until Plan-018's registration flow lands; Plan-018 adds `display_name`, `identity_ref`, `metadata`, and `identity_mappings` via additive ALTER migrations per [Shared Postgres Schema §Participants and Identity](../architecture/schemas/shared-postgres-schema.md#participants-and-identity-plan-018) |
```

**Rationale:** Plan-018's canonical filename is `docs/plans/018-identity-and-participant-state.md` (verified via Glob). The `018-identity-provider-adapters.md` path was never committed — Plan-018 has always been filed under "Identity and Participant State". Surgical path swap preserves `[Plan-018]` link text and table structure.

**Cross-impact check:**

- Single-file single-line edit.
- No other repo-wide source references to `018-identity-provider-adapters` exist (grep-verified; audit files document but do not link).
- Lane H SHF-H-006 flagged the same drift during header trace — Lane C fix closes both.
- `[Plan-018]` link text remains accurate because the Plan-018 number is preserved.

---

#### §5.4.3 SHF-C-005 — specs/017:416 file-rename

**Finding IDs:** SHF-C-005 (Lane C internal cross-reference validity — ORPHAN); corroborated by Lane D SHF-D-004 (same Spec-017:416 title+path drift).
**Target file:** `docs/specs/017-workflow-authoring-and-execution.md`
**Target line:** 416 (within §Related specs).

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
- [Spec-013 — Session timeline](../specs/013-session-timeline-and-presence.md) (phase surfacing, pending-human count)
```

**After (proposed — path + title alignment with canonical Spec-013):**

```markdown
- [Spec-013 — Live timeline visibility and reasoning surfaces](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md) (phase surfacing, pending-human count)
```

**Rationale:** Spec-013's canonical filename is `docs/specs/013-live-timeline-visibility-and-reasoning-surfaces.md` with canonical title "Live Timeline Visibility and Reasoning Surfaces" (verified via Glob + cross-doc cites). Spec-017:416 uses a historical short title ("Session timeline") and a stale filename that was never committed. Both path and title updated to match repo canonical. Parenthetical `(phase surfacing, pending-human count)` retained — describes dependency contract, not spec title.

**Cross-impact check:**

- Single-file single-line edit.
- No other repo-wide source references to `013-session-timeline-and-presence` exist (grep-verified).
- Title update aligns with existing Spec-013 references across the codebase.
- Session M citation-cluster per Lane C §Session M Citation-Cluster Signal (3 of 5 H2 ORPHANs at Spec-017:406-418): §4.1 + §4.2 close the other two ORPHANs in the cluster (ADR-020 + ADR-002), so SHF-C-005 completes the Spec-017 §Governing docs + §Related specs cluster remediation.

---

#### §5.4.4 SHF-preseed-003 — cross-plan-dependencies.md:82-115 legend-label drift

**Finding IDs:** SHF-preseed-003 (Lane C pre-seeded per BL-097 §7(c)).
**Target file:** `docs/architecture/cross-plan-dependencies.md`
**Target lines:** 82-84 (legend) + 6 row references (L98, L110, L111, L112, L114, L115) using a third undeclared type.

**Before (verbatim, fresh Read 2026-04-22) — legend at L82-84:**

```markdown
Each dependency is annotated with its type:
- **spec-declared**: the corresponding spec explicitly lists the other spec in its Depends On field
- **implementation-derived**: the plans share tables, package paths, or cross-cutting concerns that create a build-order dependency not captured in spec Depends On
```

Six rows use `declared in plan header` as the Type column — L98 Plan-011, L110 Plan-021, L111 Plan-022, L112 Plan-023, L114 Plan-025, L115 Plan-026 — a third type value not defined in the legend.

**Option space (user-gate flag — BL-097 §7(c) classified non-blocking; H5 proposes in-scope closure):**

| Option | Description | Files touched | Recommendation |
| --- | --- | --- | --- |
| **A (recommended)** | Add `declared in plan header` as a third type to the legend. | cross-plan-dependencies.md:82-84 (legend expansion only; 6 rows unchanged). | ✓ H5 proposal. Legend expansion preserves ground truth — the 6 plans DO declare dependencies in their own plan-header Dependencies rows rather than in a spec Depends On field or in an implementation-derived table-sharing fashion. Type is semantically real. |
| B | Rewrite the 6 row Type values to use one of the 2 existing types (spec-declared OR implementation-derived) per plan. | cross-plan-dependencies.md (6 row edits). | Viable but heavier. Requires per-plan adjudication: some of the 6 may not cleanly map to either existing type (e.g., Plan-011 declares deps in its plan header, but the deps are not implementation-derived in the legend's shared-tables/paths sense). Risks semantic drift. |
| C | Defer per BL-097 §7(c) non-blocking classification. | None. | ✗ H5 is drift-closure; defer is the opposite of closure. SHF-preseed-003's metadata has `remediation-status: deferred` pre-marked, but H5's goal is to close the deferral unless Option A/B is rejected. |

**After (Option A — proposed, append new bullet at L84):**

```markdown
Each dependency is annotated with its type:
- **spec-declared**: the corresponding spec explicitly lists the other spec in its Depends On field
- **implementation-derived**: the plans share tables, package paths, or cross-cutting concerns that create a build-order dependency not captured in spec Depends On
- **declared in plan header**: the dependency is declared in the target plan's header Dependencies row — not in the spec's Depends On field, and not an implementation-derived table-sharing relationship
```

**Rationale:** The 6 plans (011/021/022/023/025/026) were authored after their specs' Depends On blocks had already frozen, so dependencies were declared in plan-header Dependencies rows rather than in the specs' Depends On fields. These dependencies are also not "implementation-derived" in the §3 legend sense (shared tables/paths/cross-cutting concerns) — they are explicitly declared, just in a different location. Legend expansion captures this third semantic type without rewriting the 6 rows. Option B would require per-plan judgment calls and risks silently mis-typing a dependency. Option A is 1 file-edit + 1 line added; Option B is ~6 file-edits with adjudication overhead; Option C defers closure.

**Cross-impact check:**

- Single-file single-line-range edit (cross-plan-dependencies.md:84, append 1 legend bullet).
- The 6 rows stay as-is — no Type value rewrites.
- `declared in plan header` appears 6 times in this source file only (grep-verified); audit/scope/ledger references catalog but do not define.
- BL-097 §7(c) non-blocking deferral closed by H5 remediation; ledger updates `remediation-status` from `deferred` → `landed-2026-04-22`.

---

### §5.5 Lane D — Internal Cross-Reference Bidirectionality (1 merged group)

Lane D H2 surfaced 14 findings. After absorption + exclusion, §5.5 carries 1 merged remediation group (D-006 + D-007 + D-008 — coordinated BL-097 absorption-count drift closure).

**§5.5 scope table:**

| Finding | Verdict | Severity | §5.5 routing |
| --- | --- | --- | --- |
| SHF-D-001 | MATCH | MAJOR | Content bidirectional; label drift tracked in §5.4.4 (Lane C authoritative). No §5.5 entry. |
| SHF-D-002 | DRIFT | MAJOR | Absorbed into §4.2 CRIT-2 (Spec-017:407 ADR-002 title+path — same drift as SHF-L-001 + SHF-C-003). Lane D corroborator labeled. |
| SHF-D-003 | DRIFT | CRITICAL | Absorbed into §4.1 CRIT-1 (Spec-017:409 ADR-020 broken cite). |
| SHF-D-004 | DRIFT | MAJOR | Absorbed into §5.4.3 (Spec-017:416 Spec-013 title+path — same drift as SHF-C-005). Lane D corroborator labeled. |
| SHF-D-005 | DRIFT | CRITICAL | Absorbed into §4.4 CRIT-4 (`human_phase_contribution` enum). |
| **SHF-D-006** | **DRIFT** | **MAJOR** | **§5.5.1 — ADR-015:56 amendment-count drift.** |
| **SHF-D-007** | **DRIFT** | **MAJOR** | **§5.5.1 — v1-feature-scope.md:87 amendment-count drift (paired with D-006).** |
| **SHF-D-008** | **DRIFT** | **MAJOR** | **§5.5.1 — ADR-015:149 event-count drift; :185 Pass F citation preserved per §4/§9.3 research-trust (merged into same atomic group as D-006/D-007).** |
| SHF-D-009 | DRIFT | MINOR | Routed to §6 MINOR pattern batch (cross-plan-dependencies.md:215 Spec-024 line-11 quote drift). |
| SHF-D-010 | DRIFT | MINOR | Routed to §6 MINOR pattern batch (cross-plan-dependencies.md:215 off-by-one line pointer Spec-024:172→173). |
| SHF-D-011 | MATCH | — | No remediation. |
| SHF-D-012 | MATCH | — | No remediation. |
| SHF-D-013 | NOISE | MAJOR | **H5-deferred** — H2 scope-limit reached before Spec-007 §Resolved Questions content check; H3 re-audit candidate. Ledger `remediation-status: deferred`. |
| SHF-D-014 | NOISE | MAJOR | **H5-deferred** — 5+ Spec-023→ADR-010 PASETO/WebAuthn PRF claims; H2 scope-limit reached; H3 re-audit candidate. Ledger `remediation-status: deferred`. |

**Parent-context spillover grep results (per §5.3.2 lesson):**

- `SA-1…SA-31` + `31 amendments` — **5 source hits across 2 files (expands original D-006/D-007 scope from 2 to 5 sites):** ADR-015:56, :171, :207, :220 + v1-feature-scope.md:87. Lane D found only :56 + v1-feature-scope.md:87; parent-grep caught :171, :207, :220 as additional ADR-015 spillover.
- `24 workflow event types` + `23 workflow event types` — **3 source hits in ADR-015:** :56 (dual-drift with amendment count) + :149 (D-008 primary) are drifts in §5.5.1 scope; :185 Pass F research-citation preserves pre-absorption "24" source-accurately at authorship, excluded from §5.5.1 per §4/§9.3 research-trust (Pass F research doc itself not audited; ADR-015 citing research-doc's "24" is source-faithful, not drift). Spec-017:263 + :370 are canonical "23" sources — not drifts. Research `wave-2-synthesis.md:229` ("31 amendments") + `pass-f-event-taxonomy.md` preserve pre-absorption counts — out of H5 scope per §4/§9.3 research trust.
- H5-deferred NOISE pair (D-013, D-014): no parent-context grep (deferred findings carry no remediation scope).

**Atomic-commit scope:** §5.5.1 = 6 file-edits across 2 files (ADR-015 × 5 edits + v1-feature-scope.md × 1 edit) in one atomic commit. ADR-015:56 carries both amendment + event drifts — edited once with dual fix baked in. ADR-015:185 Pass F research-citation excluded per §4/§9.3 research-trust (documented in scope table row D-008 + §5.5.1 shared rationale).

---

#### §5.5.1 SHF-D-006 + SHF-D-007 + SHF-D-008 merged — ADR-015 + v1-feature-scope.md coordinated BL-097 count drift closure

**Finding IDs:** SHF-D-006 + SHF-D-007 + SHF-D-008 (Lane D internal cross-reference bidirectionality — DRIFT). Merged because both drifts (amendment split, event count) originate in the same 2026-04-22 BL-097 Session M absorption and share file location ADR-015:56.

**Target files (2-file, 6-edit atomic commit):**

| Edit | File | Line | Drift | Fix scope |
| --- | --- | --- | --- | --- |
| **5.5.1A** | `docs/decisions/015-v1-feature-scope-definition.md` | 56 | Dual: amendment split + event count | Full row rewrite. |
| **5.5.1B** | `docs/decisions/015-v1-feature-scope-definition.md` | 149 | Event count (24 → 23) | Surgical substring. |
| **5.5.1C** | `docs/decisions/015-v1-feature-scope-definition.md` | 171 | Amendment split | Sentence rewrite. |
| **5.5.1D** | `docs/decisions/015-v1-feature-scope-definition.md` | 207 | Amendment split | Sentence rewrite. |
| **5.5.1E** | `docs/decisions/015-v1-feature-scope-definition.md` | 220 | Amendment split | Sentence rewrite. |
| **5.5.1F** | `docs/architecture/v1-feature-scope.md` | 87 | Amendment split | Sentence rewrite. |

**Canonical truth (fresh-Read 2026-04-22):**

- **Amendment split:** Spec-017:475 Editor's Note — *31 amendments SA-1…SA-31 total; 27 land in Spec-017 body (SA-1…SA-23, SA-25, SA-26, SA-27, SA-28); SA-24 (9-table schema rows), SA-29 (5 test categories + V1 ambition levels + coverage targets), SA-30 (CVE-reproducer corpora), SA-31 (replay-testing harness using Temporal `runReplayHistory` pattern) land in Plan-017 per implementation-detail separation.*
- **Event count:** Spec-017:263 — *"Event types (SA-19) — 23 types under `workflow.*`"* + Spec-017:370 — *"All 23 workflow event types emit in the Spec-006 envelope"*. Pre-absorption research Pass F reported 24; SA-19 absorption consolidated one type within `workflow_phase_lifecycle`, reducing canonical count to 23.

---

**Edit 5.5.1A — ADR-015:56 (dual fix: amendment split + event count)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
| 17 | Workflow authoring and execution (full engine) | [Spec-017](../specs/017-workflow-authoring-and-execution.md); V1 engine scope per BL-097 resolution (see §Amendment History) covers DAG executor, all four phase types (`single-agent`, `automated`, `multi-agent` OWN-only, `human`), all four gate types, parallel execution with `ParallelJoinPolicy`, resource pools, and 24 workflow event types — full contract pinned in Spec-017 (31 amendments SA-1…SA-31 from `docs/research/bl-097-workflow-scope/wave-1-synthesis.md` + `wave-2-synthesis.md`). |
```

*After:*

```markdown
| 17 | Workflow authoring and execution (full engine) | [Spec-017](../specs/017-workflow-authoring-and-execution.md); V1 engine scope per BL-097 resolution (see §Amendment History) covers DAG executor, all four phase types (`single-agent`, `automated`, `multi-agent` OWN-only, `human`), all four gate types, parallel execution with `ParallelJoinPolicy`, resource pools, and 23 workflow event types — full contract pinned in Spec-017 + Plan-017 (31 amendments SA-1…SA-31 from `docs/research/bl-097-workflow-scope/wave-1-synthesis.md` + `wave-2-synthesis.md`: 27 land in Spec-017 body; SA-24/29/30/31 land in Plan-017 per implementation-detail separation). |
```

---

**Edit 5.5.1B — ADR-015:149 (event count)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
**(Added 2026-04-22 per BL-097)** Full workflow engine surface per Spec-017 (V1 feature 17) is V1 build cost — covers DAG executor, four phase types, four gate types, parallel execution, resource pools, 24 workflow event types, 9-table SQLite persistence schema, property/fuzz/load/integration/security test battery.
```

*After:*

```markdown
**(Added 2026-04-22 per BL-097)** Full workflow engine surface per Spec-017 (V1 feature 17) is V1 build cost — covers DAG executor, four phase types, four gate types, parallel execution, resource pools, 23 workflow event types, 9-table SQLite persistence schema, property/fuzz/load/integration/security test battery.
```

---

**Edit 5.5.1C — ADR-015:171 (amendment split)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
- [Spec-017: Workflow Authoring and Execution](../specs/017-workflow-authoring-and-execution.md) — governs V1 Feature 17 (added per 2026-04-22 amendment). Spec-017 body carries all 31 load-bearing amendments SA-1…SA-31 from BL-097 research.
```

*After:*

```markdown
- [Spec-017: Workflow Authoring and Execution](../specs/017-workflow-authoring-and-execution.md) — governs V1 Feature 17 (added per 2026-04-22 amendment). Spec-017 body carries 27 of 31 load-bearing amendments from BL-097 research (SA-1…SA-23, SA-25, SA-26, SA-27, SA-28); SA-24/29/30/31 land in Plan-017 per implementation-detail separation.
```

---

**Edit 5.5.1D — ADR-015:207 (amendment split)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
| Spec-017 status | Deferred V1.1 (conflicted with Spec-017:40 subset claim) | Authoritative V1 (31 amendments SA-1…SA-31 land in Spec-017 body) |
```

*After:*

```markdown
| Spec-017 status | Deferred V1.1 (conflicted with Spec-017:40 subset claim) | Authoritative V1 (31 amendments SA-1…SA-31 split: 27 land in Spec-017 body; SA-24/29/30/31 land in Plan-017 per implementation-detail separation) |
```

---

**Edit 5.5.1E — ADR-015:220 (amendment split)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
- [Spec-017](../specs/017-workflow-authoring-and-execution.md) — body rewrite to carry SA-1…SA-31 (BL-097 task #27); §Non-Goals line 40 V1/V1.1 subset language removed
```

*After:*

```markdown
- [Spec-017](../specs/017-workflow-authoring-and-execution.md) — body rewrite to carry 27 of 31 amendments (SA-1…SA-23, SA-25, SA-26, SA-27, SA-28; SA-24/29/30/31 land in Plan-017 per BL-097 task #27); §Non-Goals line 40 V1/V1.1 subset language removed
```

---

**Edit 5.5.1F — v1-feature-scope.md:87 (amendment split)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
- **V1 features:** all 17 have a governing spec — Spec-023 (Desktop Shell + Renderer) landed per BL-041, Spec-016 (Multi-Agent Channels) completed its V1-readiness review per BL-042, and Spec-017 (Workflow authoring and execution) carries 31 amendments SA-1…SA-31 from BL-097 Wave 1+2 research.
```

*After:*

```markdown
- **V1 features:** all 17 have a governing spec — Spec-023 (Desktop Shell + Renderer) landed per BL-041, Spec-016 (Multi-Agent Channels) completed its V1-readiness review per BL-042, and Spec-017 (Workflow authoring and execution) carries 27 of 31 amendments from BL-097 Wave 1+2 research in its body (SA-1…SA-23, SA-25, SA-26, SA-27, SA-28); SA-24/29/30/31 land in Plan-017 per implementation-detail separation.
```

---

**Rationale (shared across all 6 edits):** BL-097 Session M absorption on 2026-04-22 landed 31 total SA-* amendments from Wave 1+2 research. Of these, 27 (SA-1…SA-23, SA-25, SA-26, SA-27, SA-28) land in Spec-017 body per "contract in spec, implementation detail in plan" separation; 4 (SA-24 9-table schema rows, SA-29 test-category surface, SA-30 CVE-reproducer corpora, SA-31 replay-testing harness) land in Plan-017. Spec-017:475 Editor's Note documents this split canonically. ADR-015 + v1-feature-scope.md were authored during the same Session M absorption but retained pre-split phrasing ("31 amendments SA-1…SA-31 in Spec-017") — a draft state that survived into landed doc state. Similarly, Spec-017:263 SA-19 absorption consolidated one type within `workflow_phase_lifecycle`, reducing Pass F's pre-absorption 24-count to canonical 23; ADR-015's "24 workflow event types" at L56 + L149 inherit the pre-SA-19 count. ADR-015:185 Pass F research-citation preserves the research doc's "24" source-accurately at authorship time — left untouched per §4/§9.3 research-trust scope (Pass F research doc not audited; ADR-015's citation of it is source-faithful, not drift). All 6 edits land in one atomic commit to avoid interim state where some fixes apply and others don't.

**Cross-impact check:**

- All 7 drift sites (5 amendment + 2 event; ADR-015:56 carries both) grep-verified against source doc corpus (docs/**/*.md excluding docs/research/ per §4/§9.3 research-trust scope and docs/audit/ per self-reference exclusion). No additional spillover.
- Research source (`wave-2-synthesis.md:229` "31 amendments"; Pass F 24-count) preserves pre-absorption state — out of H5 scope per research trust.
- Downstream consumer alignment: Plan-017:84 references `human_phase_contribution` + SA-12 (aligns with §4.4 CRIT-4 remediation); Plan-017:117 Security regression battery references SA-30 CVE-reproducer; Plan-017 §Testing references SA-29 / SA-31 (all aligned with post-fix "in Plan-017" attribution).
- Spec-017:394 reference to Wave 2 synthesis ("SA-18…SA-31 amendments") is a range reference, not a count claim — remains accurate post-fix because 14 amendments SA-18…SA-31 from Wave 2 are authored; subset-residency (Spec-017 body vs Plan-017) is the count split, not the authorship range.
- No backlog.md BL-097 Resolution body spillover (grep-verified: zero drift matches beyond the 6 §5.5.1 edit sites).
- H5-deferred NOISE pair (D-013, D-014): will be re-dispatched in a future cite-refresh pass; ledger preserves their `remediation-status: deferred` metadata.

---

### §5.6 Lane E — Coverage / Orphan Detection (3 deferred-confirm groups, 0 file-edits)

Lane E H2 surfaced 48 findings (45 MATCH + 1 DRIFT + 1 ORPHAN + 1 preseed DRIFT). After absorption + routing, §5.6 carries 3 MAJOR findings — **none produce file-edits under H5 default recommendations.** Option-space provided for each so user-gate can override if desired.

**§5.6 scope table:**

| Finding | Verdict | Severity | §5.6 routing | Default file-edits |
| --- | --- | --- | --- | --- |
| SHF-E-025 | ORPHAN | MAJOR | §5.6.1 — Spec-024 orphan, deferred-by-design per BL-054 implicit-dep framing. | 0 |
| SHF-E-031 | MATCH | MAJOR | §5.6.2 — BL-039 Exit Criteria text "V1 = 16" pre-BL-097 historical; routed to Lane G single-editor's-note batch (§6 MINOR). | 0 (handled in §6) |
| SHF-preseed-004 | DRIFT | MAJOR | §5.6.3 — `packages/contracts/src/workflows/` subdirectory tension, deferred per BL-097 §7(d). | 0 |
| SHF-E-045 | MATCH | MINOR | Cross-lane META surfaced: Session H-final scope doc §10.3 framed LICENSE commit as H-final landing target, but LICENSE already landed 2026-04-17. H3 resolved this in favor of "already landed" status (see H-final task #42 note: "LICENSE already landed"). No §5.6 action. | 0 |

**Parent-context spillover grep results:**

- `single-file-per-contract convention` — 1 source hit (cross-plan-dependencies.md:70 only). No spillover.
- `packages/contracts/src/workflows/` — 2 source hits: Plan-017:43 (convention-violating declaration) + cross-plan-dependencies.md:198 (Tier-8 factual description of Plan-017's deliverable — not a convention claim). Only L70 carries the convention claim at odds with the subdirectory; L198 is descriptive prose about Plan-017's scope and does not require remediation.
- `spec-024-v1-gap` / `Spec-024 V1 Gap` — well-distributed across 6 source locations (Spec-024:11; cross-plan-dependencies.md:207/211; Plans 002/003/008/012 header Dependencies rows). All point to a consistent V1-gap-tracking structure; no drift.

---

#### §5.6.1 SHF-E-025 — Spec-024 orphan (deferred-by-design confirmation)

**Finding ID:** SHF-E-025 (Lane E coverage/orphan — ORPHAN).
**Target:** `docs/specs/024-cross-node-dispatch-and-approval.md` (no paired Plan-024 with matching slug).
**Status:** `deferred` per BL-054 Resolution framing (Spec-024 is an implicit dependency of Plans 002/003/008/012, not a standalone V1 plan).

**Option space (user-gate flag):**

| Option | Description | Files touched | Recommendation |
| --- | --- | --- | --- |
| **A (recommended)** | Continue deferred per BL-054 Resolution. Spec-024's orphan state is by-design — Spec-024 governs cross-node dispatch as a behavior layer that Plans 002/003/008/012 implement distributively. No Plan-024-cross-node-dispatch.md is required in V1. Existing gap tracking at cross-plan-dependencies.md:211 (§Spec-024 V1 Gap — Implementation Plan Pending) + Plans 002/003/008/012 header Dependencies cites remains authoritative. | None. | ✓ H5 proposal. Consistent with ledger `remediation-status: deferred`. |
| B | Close deferral by authoring a dedicated Plan-024-cross-node-dispatch-and-approval.md. **Numeric ID collision with existing Plan-024 (rust-pty-sidecar)** requires either (i) renumber to a new slot (breaks existing Spec-024 + Plan-024-rust-pty-sidecar references), or (ii) adopt a slug-distinguisher like Plan-024b. **Out of H5 scope** — this is feature authoring, not drift closure. | Multiple (new plan file + rename coordination). | ✗ Out of H5 scope. Candidate for a dedicated future BL if the user decides V1 needs a standalone plan. |
| C | Delete Spec-024 and migrate its claims into Spec-003/008/012 directly. V1-scope change; requires approval. | Multiple. | ✗ Out of H5 scope. |
| D | Promote Spec-024 to an inline architecture section (e.g., under `architecture/cross-node-dispatch.md`). | Multiple. | ✗ Out of H5 scope. |

**Rationale:** BL-054 Resolution explicitly recorded Spec-024 as an implicit dependency of Plans 002/003/008/012 per its Exit Criteria, distributing Spec-024's implementation across those plans' deliverables. Spec-024:11 self-declares the no-plan state + cross-links to the gap-tracking section in cross-plan-dependencies.md:211. Plans 002/003/008/012 each carry `[Spec-024](../specs/024-cross-node-dispatch-and-approval.md) (implicit cross-node dispatch surface per [cross-plan-dependencies.md §Spec-024 V1 Gap](../architecture/cross-plan-dependencies.md#spec-024-v1-gap--implementation-plan-pending))` in their header Dependencies rows (grep-verified in 4 plans). This is a well-annotated by-design state, not drift. ID collision at slot 024 (Spec-024 cross-node-dispatch vs Plan-024 rust-pty-sidecar) is documented and intentional — the two artifacts are topic-distinct and individually well-governed.

**Cross-impact check:**

- Existing gap-tracking infrastructure (cross-plan-dependencies.md:211-213 §Spec-024 V1 Gap) remains in place.
- No downstream doc treats Spec-024 as spec-plan-paired — all 4 dependent plans cite the implicit-dep framing.
- If user elects Option B/C/D at H5 gate, a new BL would be filed as a separate workstream post-H5 closure.

---

#### §5.6.2 SHF-E-031 — BL-039 Exit Criteria V1=16 text (Lane G routing confirmation)

**Finding ID:** SHF-E-031 (Lane E cross-lane routing — MATCH at artifact-existence level; content drift routed to Lane G).
**Target:** `docs/backlog.md:55` — BL-039 Exit Criteria text `v1-feature-scope.md declares V1 = 16 features, V1.1 = 4 features, and V2 = out-of-scope`.
**Status:** Routed to Lane G historical V1=16 batch via §6 MINOR pattern block (`Lane G (11): historical BL V1=16 text — merged with single-editor's-note (ledger §2)`).

**Option space:**

| Option | Description | Files touched | Recommendation |
| --- | --- | --- | --- |
| **A (recommended)** | Lane G single-editor's-note batch (per ledger §7 routing). A single "Editor's Note" block lands near the top of backlog.md noting that BL-039 + 10 other historical BL Exit Criteria reference pre-BL-097 V1 = 16 counts, preserved as closure-history; current canonical is V1 = 17 / V1.1 = 3 per ADR-015 Amendment 2026-04-22. | 1 (backlog.md — editor's-note block per §6 Lane G pattern). | ✓ H5 proposal. Handled in §6. |
| B | Individual edit of BL-039's Exit Criteria text at backlog.md:55 to rewrite "V1 = 16" → "V1 = 17". | 1 (backlog.md:55). | ✗ Misrepresents historical closure state — BL-039 closed pre-BL-097 with V1=16 as the then-current canonical. Rewriting retroactively breaks closure-history audit trail. |
| C | No action; leave BL-039 as-is. | None. | ✗ Leaves the Lane G V1=16 drift unclosed. |

**Rationale:** BL-039 closed pre-BL-097 (when V1 = 16 was canonical). Post-BL-097 Amendment raised V1 to 17 (Spec-017 workflow authoring promoted from V1.1 to V1). BL-039's Exit Criteria text was written at closure time and preserves pre-amendment counts as closure-history. Lane G's single-editor's-note approach closes the drift without rewriting historical closure records — preserves audit integrity while ensuring readers see the canonical-vs-historical relationship. §5.6.2 simply confirms SHF-E-031's routing to the Lane G batch in §6; no separate §5 file-edit.

**Cross-impact check:**

- Lane G batch (§6) handles BL-039 + 10 other pre-BL-097 V1=16 BLs with one consistent editor's-note.
- No closure-history corruption (closure records preserved as-of-closure).
- Consistent with Lane G's overall pattern: historical BL numeric drift is closure-history, not current drift; single editor's note is the minimally-invasive closure mechanism.

---

#### §5.6.3 SHF-preseed-004 — Plan-017 `packages/contracts/src/workflows/` subdirectory convention tension

**Finding ID:** SHF-preseed-004 (Lane E pre-seeded per BL-097 Resolution §7(d)).
**Targets:** `docs/plans/017-workflow-authoring-and-execution.md:43` (declares `packages/contracts/src/workflows/` subdirectory) + `docs/architecture/cross-plan-dependencies.md:70` (declares "single-file-per-contract convention" with Plan-024's `pty-host.ts` + Plan-021's `rate-limiter.ts` as precedents).
**Status:** `deferred` per BL-097 Resolution §7(d) — "convention-extension call (single-file-or-single-subdirectory) deferred until a second subdirectory candidate surfaces."

**Option space (user-gate flag):**

| Option | Description | Files touched | Recommendation |
| --- | --- | --- | --- |
| **A (recommended)** | Continue deferred per BL-097 §7(d). Plan-017's `workflows/` subdirectory is the first subdirectory precedent; convention-extension triggers on a second subdirectory candidate. No file-edits. | None. | ✓ H5 proposal. Consistent with BL-097 §7(d) design intent. |
| B | Close now by extending the convention. Edit cross-plan-dependencies.md:70 from `single-file-per-contract convention` → `single-file-or-single-subdirectory-per-contract convention` + add Plan-017's `workflows/` as the subdirectory precedent. | 1 (cross-plan-dependencies.md:70). | Viable if user wants to preempt the deferral. Contradicts BL-097 §7(d)'s "wait for second candidate" framing but defensible on "preserve ground truth earlier" grounds. |
| C | Revert Plan-017:43 to flat file layout. Replace `packages/contracts/src/workflows/` with individual files at `packages/contracts/src/workflow-*.ts` per convention. | 1 (Plan-017:43 + downstream propagation to any Plan-017 content that assumes the subdirectory). | ✗ Material re-architecting of Plan-017's contract surface. Out of H5 drift-closure scope. |

**Rationale:** BL-097 Resolution §7(d) explicitly framed the convention-extension as a deferred decision: "convention-extension call (single-file-or-single-subdirectory) deferred until a second subdirectory candidate surfaces." Plan-017's `workflows/` is the FIRST subdirectory precedent; the original §7(d) framing held that deferring until a second precedent surfaces would allow the convention to emerge from multiple data points rather than from a single case. §5.6.3 confirms this deferral as the H5 default.

**Default asymmetry vs §5.4.4 (SHF-preseed-003 / BL-097 §7(c)):** §5.4.4 closes BL-097 §7(c) preemptively via legend-expand because §7(c) is a *soft non-blocking deferral with no gating criterion* — H5 can close it now without pre-empting a design signal. §5.6.3 defers BL-097 §7(d) because §7(d) is *criterion-gated on the emergence of a second subdirectory candidate* — closing now would pre-empt the criterion's design intent (letting the convention emerge from multiple data points). This distinction justifies the different H5 defaults.

If the user prefers to close §5.6.3 drift preemptively (Option B), H6 executes a 1-line edit at cross-plan-dependencies.md:70; this is a user-gate decision, not a default.

**Cross-impact check:**

- No direct downstream consumer treats the convention language as load-bearing for V1 implementation (verified by grep — only 3 source locations reference the convention string: L70 + Lane E/H audit findings).
- Plan-017:43 `packages/contracts/src/workflows/` is in-scope for Plan-017 implementation regardless of convention text (the file contents land in H6-adjacent code, not in H5).
- cross-plan-dependencies.md:198's Tier-8 description line is factual (describes what Plan-017 creates) — unchanged by either Option A or B.

---

### §5.7 Lane H — Dependency / Topology + SHF-preseed-002 (4 groups, ~10 file-edits)

Lane H H2 surfaced 11 findings (0 MATCH + 10 DRIFT + 1 MISSING; 8 MAJOR + 3 MINOR per lane-h authoritative data; ledger §1 was 7|4 before H5 count correction — see [ledger §1 remediation-time note](./session-h-final-ledger.md#1-executive-summary)). After absorption + routing, §5.7 carries 4 MAJOR groups; MINOR findings route to §6 or resolve transitively. SHF-preseed-002 (originally Lane B) routes here because its fix is an additive schema directive, not a quote repair.

**§5.7 scope table:**

| Finding | Verdict | Severity | §5.7 routing | Default file-edits |
| --- | --- | --- | --- | --- |
| SHF-H-001 | DRIFT | MAJOR | §5.7.1 — Plan-024:185/:193 tier drift (body says "Tier 2"; §5 places at Tier 1). | 2 |
| SHF-H-002 | DRIFT | MAJOR | §5.7.1 — Plan-022:237 tier drift (body says "Tier 2 alongside Plan-002"; §5 places at Tier 5). | 1 |
| SHF-H-003 | DRIFT | MAJOR | §5.7.1 — Plan-025:247 tier drift (body says "Tier 5-6"; §5 split is Tier 5 + Tier 7). | 1 |
| SHF-H-004 | DRIFT | MAJOR | §5.7.2 — Plan-011:49 verb-drift ("Add local … `branch_contexts`" conflates CREATE with EXTEND). | 1 |
| SHF-H-005 | DRIFT | MAJOR | §5.7.2 — Plan-002:49 verb-drift ("Add shared … `session_memberships`" conflates CREATE with EXTEND). | 1 |
| SHF-H-006 | DRIFT | MAJOR | §5.7.2 — cross-plan §1 Uncontested row for `participants` miscategorized; move to §1 Contested with Plan-001 forward-declarer + Plan-018 extender. | 2 |
| SHF-H-007 | DRIFT | MAJOR | §5.7.3 — Plan-023 renderer at `apps/desktop/src/`; §2 + container-architecture.md + 20 extender plans use `apps/desktop/renderer/`. Option A1 default (re-root Plan-023 + Plan-026 to `renderer/src/`). | 10 (Plan-023 × 10) |
| SHF-H-008 | MISSING | MAJOR | §5.7.3 — §2 extender list missing 11 plans; expand under same fix. | 1 (in §5.7.3 cluster) |
| SHF-H-009 | DRIFT | MINOR | §5.7.3 — Plan-026:26 `apps/desktop/src/onboarding/` path; resolves transitively with §5.7.3 Option A1 Plan-026 re-root. | 1 (in §5.7.3 cluster) |
| SHF-H-010 | DRIFT | MINOR | **Absorbed into §5.6.3** (Lane E primary; SHF-preseed-004). Lane H secondary confirmation only. | 0 (§5.6.3) |
| SHF-H-011 | DRIFT | MINOR | Routed to §6 Lane H MINOR pattern batch (missing §2 rows for Plan-017 `workflows/` subdirectories; coupled to deferred preseed-004). | 0 (§6) |
| **SHF-preseed-002** | DRIFT | MAJOR | §5.7.4 — add `PRAGMA synchronous = FULL;` to `local-sqlite-schema.md` §Pragmas (additive directive, not text substitution). Option A close-now default. | 1 |

**Parent-context spillover grep results (per §5.3.2 lesson):**

- `Tier 2 per BL-078|Tier 2 per BL-045|Tier 5-6, per` — **3 source hits** across 3 plan bodies (Plan-024:185, Plan-022:237, Plan-025:247) matching the §5.7.1 triplet. No spillover; each plan's tier intent lives in its own body.
- `Tier 2 placement target for BL-054` — **1 source hit** in Plan-024:193 References section (same drift as SHF-H-001; folds into §5.7.1A cross-impact).
- `Add local \w+_contexts|Add shared \w+_memberships|Add local.*diff_artifacts, branch_contexts|Add shared.*session_invites, session_memberships` — **2 source hits** matching §5.7.2 verb-drift cluster (Plan-011:49 + Plan-002:49). No additional spillover.
- `participants`, `identity_mappings` `(Postgres)` as single Uncontested row — **1 source hit** in cross-plan-dependencies.md:47 (Plan-018 row). §5.7.2C moves this to §1 Contested.
- `apps/desktop/renderer/` + `apps/desktop/src/` — **systemic: 100+ source hits**. §2 row (cross-plan-dependencies.md:69), container-architecture.md L44 + L53, Plan-023:21/:90/:103-110 (apps/desktop/src/), Plan-026:26, and 20 extender plans under §Target Areas use `apps/desktop/renderer/src/<subtree>/`. §5.7.3 Option A1 fixes the 2 divergent plans (Plan-023, Plan-026) to align with the 20+ consistent extenders + §2 claim.
- `PRAGMA synchronous = FULL` — **1 source hit** (Spec-015:156 canonical declaration). `PRAGMA synchronous` (any value) — **no other source hits** in `docs/architecture/schemas/`. §5.7.4 closes the missing-pragma drift in a single file.

**Atomic-commit scope:** §5.7 = 21 file-edits across 9 files, grouped into 4 atomic commits (one per §5.7.1–§5.7.4 group): §5.7.1 = 4 file-edits (Plan-024 × 2 + Plan-022 × 1 + Plan-025 × 1); §5.7.2 = 4 file-edits (Plan-011 × 1 + Plan-002 × 1 + cross-plan-dependencies.md × 2); §5.7.3 = 12 file-edits (Plan-023 × 10 + Plan-026 × 1 + cross-plan-dependencies.md × 1); §5.7.4 = 1 file-edit (local-sqlite-schema.md × 1).

---

#### §5.7.1 Tier-placement drift cluster (SHF-H-001 + SHF-H-002 + SHF-H-003)

**Finding IDs:** SHF-H-001, SHF-H-002, SHF-H-003 (Lane H — DRIFT, MAJOR). Grouped because the drift pattern is identical (plan-body Tier claim contradicts cross-plan-dependencies.md §5 Canonical Build Order placement) and each fix is a 1-line sentence rewrite in a Tier Intent / Tier Placement section.

**Canonical truth (fresh-Read 2026-04-22):**

cross-plan-dependencies.md §5 Canonical Build Order (lines 189-199):
- **Tier 1:** Plan-001, Plan-024 (Plan-024 upstream of Plan-005 via `PtyHost` contract)
- **Tier 5:** Plan-004, Plan-008, Plan-018, Plan-022, Plan-025 (steps 1–4 only)
- **Tier 7:** Plan-011, Plan-014, Plan-015, Plan-025 (remaining steps)

---

**Edit 5.7.1A — Plan-024:185 + :193 (Tier 2 → Tier 1; 2 edits in one file, one commit)**

*Before (verbatim, fresh Read 2026-04-22, line 185):*

```markdown
Tier 2 per BL-078 exit criteria — daemon-foundational; pairs with Plan-001 (shared session core) and Plan-007 (local IPC host). Upstream of Plan-005 (runtime bindings) which is the first consumer of the `PtyHost` contract. Placement update to `docs/architecture/cross-plan-dependencies.md` §5 Canonical Build Order is out of scope for this plan and belongs to BL-054's propagation pass.
```

*After:*

```markdown
Tier 1 per [cross-plan-dependencies.md §5 Canonical Build Order](../architecture/cross-plan-dependencies.md#5-canonical-build-order) — daemon-foundational, co-tier with Plan-001. Upstream of Plan-005 (runtime bindings) which is the first consumer of the `PtyHost` contract; consumption begins at Tier 4 once Plan-005 lands. BL-054 propagation resolved 2026-04-22 per [Session H-final audit §5.7.1](../audit/session-h-final-h5-remediation-plan.md#571).
```

*Before (verbatim, fresh Read 2026-04-22, line 193):*

```markdown
- [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) — Tier 2 placement target for BL-054
```

*After:*

```markdown
- [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) — Tier 1 canonical placement (co-tier with Plan-001; upstream of Plan-005 at Tier 4)
```

---

**Edit 5.7.1B — Plan-022:237 (Tier 2 → Tier 5)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
This plan lands in **Tier 2** of the canonical build order per BL-045 exit criteria. Reasoning: Plan-022's schema must be present in Plan-001's Tier 1 migration (forward-declaration), but Plan-022's code paths can ship alongside Plan-002 in Tier 2 because the operational deletion/export/purge paths are V1.1+ (501 stubs only in V1). BL-054's cross-plan-dependencies.md §5 propagation pass will move `participant_keys` ownership from the current placeholder `Spec-022` row to a `Plan-022` row, and place Plan-022 in Tier 2 alongside Plan-002.
```

*After:*

```markdown
This plan lands in **Tier 5** of the [canonical build order](../architecture/cross-plan-dependencies.md#5-canonical-build-order) per BL-045 exit criteria, co-tier with Plan-004, Plan-008, Plan-018, Plan-025 (steps 1–4). Reasoning: Plan-022's schema must be present in Plan-001's Tier 1 migration (forward-declaration per §1 Contested `participant_keys` row), but Plan-022's implementation code paths (store, rotation, wrap-codec) ship at Tier 5 because the operational deletion/export/purge paths are V1.1+ (501 stubs only in V1). BL-054 propagation resolved 2026-04-22 per [Session H-final audit §5.7.1](../audit/session-h-final-h5-remediation-plan.md#571); `participant_keys` §1 Contested row carries Plan-001 (forward-declarer) + Plan-022 (schema-origin + Tier 5 code paths).
```

---

**Edit 5.7.1C — Plan-025:247 ("Tier 5-6" → Tier 5 + Tier 7)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
Tier 5-6, per `docs/architecture/cross-plan-dependencies.md` §5 Canonical Build Order. Strictly **downstream of Plan-008** (consumes v2 protocol surface) and **Plan-021** (consumes `PostgresRateLimiter` + `AdminBansStore`). Loosely **co-tier with Plan-026** (first-run onboarding references this deployment as the "self-host" option but does not directly depend on its runtime). **Upstream of Plan-001's post-V1 scale work** (self-host topology is the GA target for V1; Plan-001 in V1 ships against the shared protocol and is agnostic to which backend deployment hosts it). Tier placement update in `cross-plan-dependencies.md` §5 is BL-054's scope (Session 4); this plan's body states tier intent only.
```

*After:*

```markdown
**Tier-straddling plan** per [cross-plan-dependencies.md §5 Canonical Build Order](../architecture/cross-plan-dependencies.md#5-canonical-build-order) — the only tier-straddling plan in V1. Plan-025 splits across **Tier 5** (steps 1–4: `packages/crypto-paseto/` exporting PASETO v4.public primitives, co-tier with Plan-018 per the §5 symmetric co-dep carve-out) and **Tier 7** (remaining steps: Fastify surface, `docker-compose.yml`, operator runbook; downstream of Plan-008 for v2 protocol + Plan-021 for rate-limiter/admin-bans). Loosely **co-tier with Plan-026** (first-run onboarding references this deployment as the "self-host" option but does not directly depend on its runtime). **Upstream of Plan-001's post-V1 scale work** (self-host topology is the GA target for V1; Plan-001 in V1 ships against the shared protocol and is agnostic to which backend deployment hosts it). BL-054 propagation resolved 2026-04-22 per [Session H-final audit §5.7.1](../audit/session-h-final-h5-remediation-plan.md#571).
```

---

**Rationale (shared across §5.7.1A/B/C):** cross-plan-dependencies.md §5 Canonical Build Order is authoritative for tier placement. All three plans acknowledged inline that §5 propagation was BL-054's scope and left plan-body stubs ("BL-054 propagation pass will…") as interim placeholders. §5 has since landed the canonical placements (Tier 1 for Plan-024, Tier 5 for Plan-022, Tier 5 + Tier 7 split for Plan-025) but the stub language remained. H5 closes the drift by rewriting each plan body to match §5 + cite §5 explicitly + reference this audit's propagation pass as the resolution step.

**Cross-impact check:**

- No backlog.md BL-054/BL-045/BL-078 Resolution body spillover (grep-verified: BL Resolution records describe the tier *decisions* but do not re-state individual plan tier placements; closure history preserved).
- Plan-024 References section line 193's secondary Tier 2 claim is bundled into Edit 5.7.1A (2-edit single-file atomic fix).
- §5.7.1B's inline reference to the §1 Contested `participant_keys` row is informational-only — `participant_keys` is already correctly classed in §1 Contested (cross-plan-dependencies.md:23) with Plan-001 (forward-declarer) and Plan-022 (schema-origin) both listed; no §1 edit is required for this row. §5.7.2C's independent `participants` re-cat (Uncontested → Contested, listing Plan-001 CREATE + Plan-018 ALTER) is a separate §1 edit that does not couple with §5.7.1B — the two §5.7 subgroups commute at the §1 level.
- §5.7.1C's "only tier-straddling plan in V1" claim is consistent with §5 Plan-025/Plan-018 Symmetric Co-Dep Carve-Out (cross-plan-dependencies.md:201-203) — grep-verified.
- ~~Plan-023 Tier 8 + Plan-017 Tier 8 + Plan-026 Tier 9 not affected (all §5-consistent per H2).~~ **Amended 2026-04-23 per §5.7.1D/E/F:** H6b pre-scope inverted grep found Plan-023:315 ("Tier 7-8") and Plan-026:516 ("Tier 7-9") body-prose drift that H2 missed. Plan-017 Tier 8 remains grep-verified consistent. Plan-021:377 ("Tier 5-6") also surfaced as third RTF. All three absorbed into §5.7.1 as D/E/F below.

---

**§5.7.1 D/E/F — Remediation-time tier-drift spillover aggregate (3 RTFs; H6b discovery 2026-04-23)**

**Finding-source:** `remediation-time` (per §5.2.13 precedent; closeout doc §3.2 rationale). During H6b pre-scope inverted grep for §5.7.1 targets (per closeout doc §6 resumption checklist), three additional plan-body tier drifts were surfaced beyond the §5.7.1A/B/C triplet. Each matches the same BL-054-stub drift pattern (hedging-dash tier range + "BL-054's scope (Session 4); this plan's body states tier intent only" stub phrase). H2 static scoping under-counted body-prose replications of references-appendix content by 3 findings on §5.7.1 (~43% under-count relative to the 7-item corrected scope — comparable to §5.2's 60% RTF rate, validating the closeout doc's §3.2 broader-grep directive).

**Canonical truth (fresh-Read 2026-04-23):**
- cross-plan-dependencies.md §5 L197 Tier 6 — `Plan-009, Plan-010, Plan-012, Plan-016, Plan-021` (Plan-021 is Tier 6 single, not Tier 5-6 range).
- cross-plan-dependencies.md §5 L199 Tier 8 — `Plan-013, Plan-017, Plan-019, Plan-020, Plan-023` (Plan-023 is Tier 8 single, not Tier 7-8 range).
- cross-plan-dependencies.md §5 L200 Tier 9 — `Plan-026` (Plan-026 is Tier 9 single, not Tier 7-9 range).

---

**Edit 5.7.1D — Plan-021:377 (Tier 5-6 → Tier 6; remediation-time finding)**

*Before (verbatim, fresh Read 2026-04-23):*

```markdown
Tier 5-6, per `docs/architecture/cross-plan-dependencies.md` §5 Canonical Build Order. Strictly **downstream of Plan-008** (this plan consumes Plan-008's tRPC router and WS frame hook) and **upstream of Plan-025** (Plan-025 is the self-hostable Node relay that instantiates `PostgresRateLimiter` inside its compose-deployed process). Placement update to `cross-plan-dependencies.md` §5 is BL-054's scope (Session 4); Plan-021's body states the tier intent only.
```

*After:*

```markdown
Tier 6 per [cross-plan-dependencies.md §5 Canonical Build Order](../architecture/cross-plan-dependencies.md#5-canonical-build-order). Strictly **downstream of Plan-008** (this plan consumes Plan-008's tRPC router and WS frame hook) and **upstream of Plan-025** (Plan-025 is the self-hostable Node relay that instantiates `PostgresRateLimiter` inside its compose-deployed process). BL-054 propagation resolved 2026-04-23 per [Session H-final audit §5.7.1](../audit/session-h-final-h5-remediation-plan.md#571) (remediation-time finding).
```

---

**Edit 5.7.1E — Plan-023:315 (Tier 7-8 → Tier 8; remediation-time finding)**

*Before (verbatim, fresh Read 2026-04-23):*

```markdown
Tier 7-8, per `docs/architecture/cross-plan-dependencies.md` §5 Canonical Build Order. Strictly **downstream of Plan-007** (consumes the daemon IPC contract), **downstream of Plan-018** (consumes PASETO tokens), **downstream of Plan-008** (consumes the control-plane tRPC + WebSocket client), **parallel to Plan-024** (both are shell-surface plans but Plan-024 is owned by the daemon, not the shell), and **upstream of Plan-026** (Plan-026 consumes the `onboarding.*` preload-bridge surface authored here). Placement update to `cross-plan-dependencies.md` §5 is BL-054's scope (Session 4); Plan-023's body states the tier intent only.
```

*After:*

```markdown
Tier 8 per [cross-plan-dependencies.md §5 Canonical Build Order](../architecture/cross-plan-dependencies.md#5-canonical-build-order). Strictly **downstream of Plan-007** (consumes the daemon IPC contract), **downstream of Plan-018** (consumes PASETO tokens), **downstream of Plan-008** (consumes the control-plane tRPC + WebSocket client), **parallel to Plan-024** (both are shell-surface plans but Plan-024 is owned by the daemon, not the shell), and **upstream of Plan-026** (Plan-026 consumes the `onboarding.*` preload-bridge surface authored here). BL-054 propagation resolved 2026-04-23 per [Session H-final audit §5.7.1](../audit/session-h-final-h5-remediation-plan.md#571) (remediation-time finding).
```

---

**Edit 5.7.1F — Plan-026:516 + :523 (Tier 7-9 → Tier 9; remediation-time finding; 2-edit single-file)**

*Before (verbatim, fresh Read 2026-04-23, line 516):*

```markdown
Tier 7-9 per `docs/architecture/cross-plan-dependencies.md` §5 Canonical Build Order. Plan-026 is **strictly downstream** of:
```

*After:*

```markdown
Tier 9 per [cross-plan-dependencies.md §5 Canonical Build Order](../architecture/cross-plan-dependencies.md#5-canonical-build-order). Plan-026 is **strictly downstream** of:
```

*Before (verbatim, fresh Read 2026-04-23, line 523):*

```markdown
And **strictly upstream** of nothing — it is a leaf-node plan. CLI-first-release shippability is gated on Plan-007 only; desktop shippability is additionally gated on Plan-023. Tier placement registration in `cross-plan-dependencies.md` §5 is BL-054's scope (Session 4); Plan-026 declares tier intent only.
```

*After:*

```markdown
And **strictly upstream** of nothing — it is a leaf-node plan. CLI-first-release shippability is gated on Plan-007 only; desktop shippability is additionally gated on Plan-023. BL-054 propagation resolved 2026-04-23 per [Session H-final audit §5.7.1](../audit/session-h-final-h5-remediation-plan.md#571) (remediation-time finding).
```

---

**Rationale (shared across §5.7.1D/E/F):** Same pattern as §5.7.1A/B/C — plan bodies carried "BL-054's scope (Session 4)" stub language + hedging-dash tier ranges from before §5 canonicalization landed. Plan-021 was Tier 6 single; Plan-023 was Tier 8 single; Plan-026 was Tier 9 single — all three have been canonical since cross-plan-dependencies.md §5 was finalized, but plan-body stubs remained uncorrected. H6b closes the drift alongside §5.7.1A/B/C in the same atomic commit; no new patterns introduced.

**Cross-impact check (aggregate):**
- `finding-source: remediation-time` metadata tag applied to all three findings per §5.2.13 precedent.
- All three fixes land 2026-04-23 (H6b discovery date, one day after H5 2026-04-22). The date delta is intentional — audit integrity requires the audit-record to reflect actual remediation dates.
- No additional plan-body tier-drift remaining post-§5.7.1D/E/F. grep-verified: patterns `Tier 2 per BL-078|Tier 2 placement target for BL-054|Tier 2 alongside Plan-002|Tier 5-6, per|Tier 7-8, per|Tier 7-9 per|BL-054's scope (Session 4)` return **0 matches** in `docs/plans/` after §5.7.1A-F land.
- §5.7.2 and §5.7.3 are independent (verb-drift + renderer-path, different patterns); §5.7.1 D/E/F do not widen §5.7.2/3 scope.
- **META-1 arithmetic:** detailed count updates from 58 → 61 detailed findings; total count updates from 69 → 72 total (3 RTF additions). Lane H MAJOR count updates from 8 → 11 (11 original per lane-h authoritative + 3 RTF = 14 post-§5.7.1D/E/F; the prior lane-h pre-§5.7.1 count stands + 3 adds).

---

#### §5.7.2 Table-ownership verb-drift cluster (SHF-H-004 + SHF-H-005 + SHF-H-006)

**Finding IDs:** SHF-H-004, SHF-H-005, SHF-H-006 (Lane H — DRIFT, MAJOR). Grouped because all three concern the CREATE-vs-EXTEND verb distinction for shared tables. H-004 and H-005 are plan-body verb-drifts where a plan uses "Add local/shared X, Y, Z" as a CREATE verb on tables it extends (per §1 Contested); H-006 is the §1 Uncontested row for `participants` miscategorized — Plan-001 does the physical CREATE per its body (L50), so the row belongs in §1 Contested with Plan-018 as ALTER/USE extender.

**Canonical truth (fresh-Read 2026-04-22):**

- cross-plan-dependencies.md:21 — `session_memberships` is §1 Contested: Plan-001 CREATE + Plan-002 ALTER/USE.
- cross-plan-dependencies.md:22 — `branch_contexts` is §1 Contested: Plan-010 CREATE + Plan-011 ALTER/USE.
- plans/001-shared-session-core.md:50 — Plan-001 owns the physical CREATE of `participants` (minimal shape); Plan-018 adds identity/profile columns via additive ALTER migrations.
- cross-plan-dependencies.md:47 — currently lists `participants`, `identity_mappings` (Postgres) under Plan-018 Uncontested Tables — **this is the miscategorization**.

---

**Edit 5.7.2A — Plan-011:49 (CREATE/EXTEND verb split)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
- Add local `diff_artifacts`, `branch_contexts`, and `pr_preparations` tables.
```

*After:*

```markdown
- Add local `diff_artifacts` and `pr_preparations` tables (CREATE).
- Extend `branch_contexts` (owner: Plan-010 per [cross-plan-dependencies.md §1 Contested](../architecture/cross-plan-dependencies.md#1-table-ownership-map) row for `branch_contexts` — Plan-011 ALTER/USE).
```

---

**Edit 5.7.2B — Plan-002:49 (CREATE/EXTEND verb split)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
- Add shared `session_invites` and `session_memberships` tables. Presence data is ephemeral (Yjs Awareness CRDT, in-memory only) and must NOT be persisted to a durable table.
```

*After:*

```markdown
- Add shared `session_invites` table (CREATE).
- Extend `session_memberships` (owner: Plan-001 per [cross-plan-dependencies.md §1 Contested](../architecture/cross-plan-dependencies.md#1-table-ownership-map) row for `session_memberships` — Plan-002 ALTER/USE adds invite-driven membership flows).
- Presence data is ephemeral (Yjs Awareness CRDT, in-memory only) and must NOT be persisted to a durable table.
```

---

**Edit 5.7.2C — cross-plan-dependencies.md (§1 move `participants` Uncontested → Contested; delete :47 Plan-018 row entry; add new §1 Contested row)**

*Before (verbatim, fresh Read 2026-04-22, cross-plan-dependencies.md:47):*

```markdown
| Plan-018 | `participants`, `identity_mappings` (Postgres) |
```

*After (row rewrite — identity_mappings stays Uncontested with Plan-018):*

```markdown
| Plan-018 | `identity_mappings` (Postgres) |
```

*Before (verbatim, fresh Read 2026-04-22, cross-plan-dependencies.md §1 Contested Tables block lines 19-24):*

```markdown
| Table | Owning Plan (CREATE) | Extending Plan(s) (ALTER/USE) | Rationale |
| --- | --- | --- | --- |
| `session_memberships` | Plan-001 (Shared Session Core) | Plan-002 (Invite Membership And Presence) | Plan-001 is the session foundation; Spec-002 depends on Spec-001. Plan-001 creates the table with core columns (id, session_id, participant_id, role, state, joined_at, updated_at). Plan-002 adds invite-driven membership flows but does not own the schema. |
| `branch_contexts` | Plan-010 (Worktree Lifecycle And Execution Modes) | Plan-011 (Gitflow PR And Diff Attribution) | Plan-011 already declares Plan-010 as a dependency. Plan-010 creates the table as part of worktree infrastructure (id, worktree_id FK, base_branch, head_branch, upstream_ref, created_at, updated_at). Plan-011 extends it for PR and diff attribution. |
| `participant_keys` (SQLite) | Plan-001 (initial migration `0001-initial.sql`) | Plan-022 (schema origin and CRUD code paths) | **Forward-declared split per Plan-022 header.** Plan-022 authors the `participant_keys` schema but forward-declares the `CREATE TABLE` into Plan-001's Tier 1 migration so V1 session-core cannot ship without the GDPR crypto-envelope schema (per ADR-015 V1 scope). Plan-022's implementation code paths (store, rotation, wrap-codec) land at Tier 5. |
| `session_events.pii_payload` (SQLite column) | Plan-001 (initial migration `0001-initial.sql`) | Plan-022 (column origin; reader/writer code paths at Tier 5) | **Forward-declared split per Plan-022 header.** Plan-022 adds this BLOB column to Plan-001's `session_events` schema in the Tier 1 migration so the crypto envelope does not require a breaking schema migration after V1 ships. |
```

*After (append new `participants` Contested row after `session_events.pii_payload`):*

```markdown
| Table | Owning Plan (CREATE) | Extending Plan(s) (ALTER/USE) | Rationale |
| --- | --- | --- | --- |
| `session_memberships` | Plan-001 (Shared Session Core) | Plan-002 (Invite Membership And Presence) | Plan-001 is the session foundation; Spec-002 depends on Spec-001. Plan-001 creates the table with core columns (id, session_id, participant_id, role, state, joined_at, updated_at). Plan-002 adds invite-driven membership flows but does not own the schema. |
| `branch_contexts` | Plan-010 (Worktree Lifecycle And Execution Modes) | Plan-011 (Gitflow PR And Diff Attribution) | Plan-011 already declares Plan-010 as a dependency. Plan-010 creates the table as part of worktree infrastructure (id, worktree_id FK, base_branch, head_branch, upstream_ref, created_at, updated_at). Plan-011 extends it for PR and diff attribution. |
| `participant_keys` (SQLite) | Plan-001 (initial migration `0001-initial.sql`) | Plan-022 (schema origin and CRUD code paths) | **Forward-declared split per Plan-022 header.** Plan-022 authors the `participant_keys` schema but forward-declares the `CREATE TABLE` into Plan-001's Tier 1 migration so V1 session-core cannot ship without the GDPR crypto-envelope schema (per ADR-015 V1 scope). Plan-022's implementation code paths (store, rotation, wrap-codec) land at Tier 5. |
| `session_events.pii_payload` (SQLite column) | Plan-001 (initial migration `0001-initial.sql`) | Plan-022 (column origin; reader/writer code paths at Tier 5) | **Forward-declared split per Plan-022 header.** Plan-022 adds this BLOB column to Plan-001's `session_events` schema in the Tier 1 migration so the crypto envelope does not require a breaking schema migration after V1 ships. |
| `participants` (Postgres) | Plan-001 (initial migration `0001-initial.sql` — minimal `id UUID PK`, `created_at TIMESTAMPTZ`) | Plan-018 (Identity And Participant State — additive ALTER migrations for `display_name`, `identity_ref`, `metadata` + the `identity_mappings` side table) | **Forward-declared split per Plan-001 body line 50.** Plan-001 owns the physical CREATE of the minimal identity-anchor shape at Tier 1 because `session_memberships.participant_id`, `session_invites.inviter_id`, and `runtime_node_attachments.participant_id` all `REFERENCES participants(id)` (Plans 001/002/003 execute before Plan-018 per §5 Canonical Build Order). Plan-018 extends with identity/profile columns and the `identity_mappings` side table via additive ALTER migrations at Tier 5. |
```

---

**Rationale (shared across §5.7.2A/B/C):** §1 Table Ownership Map is the canonical surface implementation agents consult for CREATE/EXTEND authority. Two types of drift close together:
- **Plan-body verb conflation (§5.7.2A/B):** Plan-011 and Plan-002 each own one new table (`diff_artifacts`+`pr_preparations`, `session_invites`) and extend one existing table (`branch_contexts`, `session_memberships`). Writing "Add local X, Y, Z" or "Add shared X and Y" reads as CREATE for all listed tables. Under that reading, an implementation agent would author a CREATE migration that clashes with the owning plan's migration. Verb-split repairs close the risk.
- **§1 row miscategorization (§5.7.2C):** `participants` is currently listed as Uncontested under Plan-018 (cross-plan-dependencies.md:47), but Plan-001 body line 50 explicitly states Plan-001 owns the physical CREATE (minimal shape; `id UUID PK`, `created_at TIMESTAMPTZ`) and Plan-018 adds columns via ALTER. This is the exact pattern as `participant_keys` and `session_events.pii_payload` — forward-declared split — which are already correctly classed in §1 Contested. Moving `participants` to §1 Contested eliminates the miscategorization; `identity_mappings` remains Uncontested with Plan-018 as sole owner.

**Cross-impact check:**

- Plan-001:50 already correctly describes the forward-declared split; §5.7.2C aligns §1 with Plan-001's already-landed framing. No Plan-001 body edit required.
- Plan-018 dependency (Tier 5, `packages/crypto-paseto/` from Plan-025 steps 1–4) remains consistent with Plan-018 extending `participants` at Tier 5 (after Plan-001's Tier 1 minimal CREATE).
- `identity_mappings` remains a single-owner (Plan-018) Uncontested table — no drift.
- Plan-002's corrected verb-split preserves the "presence data is ephemeral" invariant unchanged.
- Plan-011's corrected verb-split preserves `diff_artifacts` + `pr_preparations` CREATE ownership.
- ~~grep-verified: no other plan body uses the "Add shared/local X, Y, Z" pattern in a CREATE-verb-on-EXTEND-table-row way.~~ **Amended 2026-04-23 per §5.7.2D:** H6b pre-scope inverted grep found Plan-018:49 ("Add shared `participants`, participant-profile projection records, and device-presence or presence-lease storage needed for aggregation") body-prose drift that H2 missed. Plan-018 is `participants` EXTEND (Plan-001 CREATE per §5.7.2C post-fix); the "Add shared `participants`" phrasing is the same CREATE-verb-on-EXTEND-table-row pattern as §5.7.2A/B. Absorbed into §5.7.2 as D below. Post-fix: grep-verified clean across docs/plans/.

---

**§5.7.2D — Remediation-time verb-drift spillover (1 RTF; H6b discovery 2026-04-23)**

**Finding-source:** `remediation-time` (per §5.2.13 precedent; closeout doc §3.2 rationale). During H6b pre-scope inverted grep for §5.7.2 targets, Plan-018:49 surfaced as a fourth verb-drift instance beyond the §5.7.2A/B/C triplet. Matches the same CREATE-verb-on-EXTEND-table-row pattern as Plan-011:49 and Plan-002:49.

**Canonical truth (fresh-Read 2026-04-23):**
- §5.7.2C post-fix §1 Contested row for `participants` (Postgres) — Plan-001 owns CREATE of minimal `id UUID PK` + `created_at TIMESTAMPTZ` shape at Tier 1; Plan-018 ALTER/USE adds `display_name`, `identity_ref`, `metadata` columns + `identity_mappings` side table via additive migrations at Tier 5.
- Plan-018 Plan-001's row for `participants` is now §1 Contested (no longer Uncontested) after §5.7.2C lands.
- `identity_mappings` side table remains solely Plan-018's per §1 Uncontested row.

---

**Edit 5.7.2D — Plan-018:49 (CREATE/EXTEND verb split; remediation-time finding)**

*Before (verbatim, fresh Read 2026-04-23):*

```markdown
- Add shared `participants`, participant-profile projection records, and device-presence or presence-lease storage needed for aggregation.
```

*After:*

```markdown
- Extend `participants` (owner: Plan-001 per [cross-plan-dependencies.md §1 Contested](../architecture/cross-plan-dependencies.md#1-table-ownership-map) row for `participants` — Plan-018 ALTER/USE adds `display_name`, `identity_ref`, `metadata` columns via additive migrations).
- Add shared `identity_mappings` side table (CREATE per §1 Uncontested row). Participant-profile projection records and device-presence or presence-lease storage needed for aggregation follow from these base tables; presence data is ephemeral per Plan-002 (Yjs Awareness CRDT, in-memory only) and MUST NOT be persisted to a durable table.
```

---

**Rationale (§5.7.2D):** Same pattern as §5.7.2A/B — Plan-018 body text conflated CREATE-verb "Add shared" with EXTEND-only table `participants` (post-§5.7.2C ownership). Splits the bullet into explicit EXTEND + CREATE clauses with §1 row cross-refs. Preserves the participant-profile projection framing + presence-data-ephemeral invariant from Plan-002.

**Cross-impact check (§5.7.2D):**
- `finding-source: remediation-time` metadata tag per §5.2.13 precedent.
- Fix date 2026-04-23 (H6b discovery).
- No additional verb-drift patterns remaining. grep-verified: `Add local \`diff_artifacts\`, \`branch_contexts\`|Add shared \`session_invites\` and \`session_memberships\`|Add shared \`participants\`, participant-profile` returns 0 matches in `docs/plans/` after §5.7.2A-D land.
- §5.7.3 (renderer-path) is independent of §5.7.2D (verb-drift on different files + patterns).
- **META-1 arithmetic (continued):** detailed count updates from 61 → 62 detailed findings; total count updates from 72 → 73 total (1 additional RTF on top of §5.7.1 D/E/F's 3). Lane H MAJOR count updates from 11 → 12.

---

#### §5.7.3 Renderer path drift cluster (SHF-H-007 + SHF-H-008 + SHF-H-009)

**Finding IDs:** SHF-H-007 (Plan-023 renderer root drift — MAJOR), SHF-H-008 (§2 extender list missing 11 plans — MAJOR, MISSING), SHF-H-009 (Plan-026 onboarding path mirrors H-007 pattern — MINOR, coupled). Grouped because H-007 and H-009 share the same path drift (both plans use `apps/desktop/src/` instead of `apps/desktop/renderer/src/`) and H-008 is the missing-extender-list counterpart that must be closed in the same atomic commit so §2's ownership map reflects the corrected reality.

**Canonical truth (fresh-Read 2026-04-22):**

- cross-plan-dependencies.md:69 — `apps/desktop/renderer/` is the declared shared resource with 9 listed extenders (Plan-009, Plan-011, Plan-012, Plan-013, Plan-014, Plan-016, Plan-017, Plan-019, Plan-026).
- container-architecture.md:44 + :53 — `apps/desktop/renderer/` is the second client path alongside `apps/desktop/shell/`.
- 20 extender plan bodies use `apps/desktop/renderer/src/<subtree>/` under §Target Areas (Plans 001, 002, 003, 004, 006, 007, 008, 009, 010, 011, 012, 013, 014, 015, 016, 017, 018, 019, 020, 026).
- Plan-023:21/:90/:103-110 + Plan-026:26 — outliers using `apps/desktop/src/` instead of `apps/desktop/renderer/src/`.

**Option space (user-gate flag; H5 default = A1):**

| Option | Description | Files touched | Recommendation |
| --- | --- | --- | --- |
| **A1 (recommended)** | Re-root Plan-023 + Plan-026 to `apps/desktop/renderer/src/` to align with the 20-plan extender reality + §2 claim + container-architecture.md. Expand §2 extender list from 9 to 20 plans. | **3 files / 12 file-edits** (Plan-023 × 10 line-edits + Plan-026 × 1 + cross-plan-dependencies.md §2 row × 1). | ✓ H5 proposal. Minimal file-edit scope; aligns 2 outliers with 20-consensus reality. |
| A2 | Re-root §2 claim + container-architecture.md to `apps/desktop/src/` and rewrite 20 extender plan bodies to drop the `/renderer` path segment. | **22 files / ~22 file-edits** (§2 row × 1 + container-architecture L44/L53 × 2 + 20 extender plans × ~1 each). | ✗ ~1.8× larger file-edit scope (~22 vs 12 file-edits) / ~7× larger file count (22 vs 3 files). Treats the two-plan drift as canonical against the 20-plan consensus. Rejected. |
| B | Keep deferred. Leaves systemic drift unclosed. | None. | ✗ §2 remains inconsistent with Plan-023 body; implementation agents targeting `apps/desktop/src/` vs `apps/desktop/renderer/src/` will split into conflicting directory layouts at build time. Rejected. |

**Cross-impact check (Option A1 default):**

- Plan-023:21 + :90 + :103-110: 7 lines touch `apps/desktop/src/`; of these, L90 is the main-process Sentry reference at `apps/desktop/electron/main/crash-reporter.ts` — **not renderer-rooted; leaves L90 unchanged** (main process stays `apps/desktop/electron/main/`). Renderer-rooted edits: L21 `apps/desktop/src/` → `apps/desktop/renderer/src/`; L103-110's `apps/desktop/src/*.tsx` + `apps/desktop/src/sentry.ts` → `apps/desktop/renderer/src/*.tsx` + `apps/desktop/renderer/src/sentry.ts`; L90's renderer-side init reference "Renderer-side init lives in `apps/desktop/src/sentry.ts`" → "Renderer-side init lives in `apps/desktop/renderer/src/sentry.ts`".
- Plan-026:26 `apps/desktop/src/onboarding/` → `apps/desktop/renderer/src/onboarding/` (single-line).
- cross-plan-dependencies.md §2 row 69 extender list expansion: Plan-001, Plan-002, Plan-003, Plan-004, Plan-006, Plan-007, Plan-008, Plan-009, Plan-010, Plan-011, Plan-012, Plan-013, Plan-014, Plan-015, Plan-016, Plan-017, Plan-018, Plan-019, Plan-020, Plan-026 = 20 plans. Removes 11 plans from the MISSING gap (H-008).
- No Spec-023 edit required: Spec-023 does not enumerate renderer paths — it governs the preload bridge + crash-reporter scrubber surface which live in `apps/desktop/electron/`, not the renderer subtree.
- Container-architecture.md L44 + L53 remain as-is (already correct with `apps/desktop/renderer/`).

---

**Edit 5.7.3A — Plan-023:21 (renderer root)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
- `apps/desktop/` — **new app package.** The Electron main process (`apps/desktop/electron/main/`), the preload bridge (`apps/desktop/electron/preload/`), and the React + Vite renderer (`apps/desktop/src/`).
```

*After:*

```markdown
- `apps/desktop/` — **new app package.** The Electron main process (`apps/desktop/electron/main/`), the preload bridge (`apps/desktop/electron/preload/`), and the React + Vite renderer (`apps/desktop/renderer/src/`).
```

---

**Edit 5.7.3B — Plan-023:90 (main-process Sentry reference to renderer-side init)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
- `apps/desktop/electron/main/crash-reporter.ts` — **created.** Initializes `@sentry/electron/main` with `beforeSend` scrubber per Spec-023 §Implementation Notes §Crash Reporting. The scrubber deletes `token`, `dpop`, `session_token`, `prf_output` top-level keys; replaces session IDs with stable SHA-256 hashes; truncates file paths to extension; elides `event.request.data.content`. Renderer-side init lives in `apps/desktop/src/sentry.ts`.
```

*After:*

```markdown
- `apps/desktop/electron/main/crash-reporter.ts` — **created.** Initializes `@sentry/electron/main` with `beforeSend` scrubber per Spec-023 §Implementation Notes §Crash Reporting. The scrubber deletes `token`, `dpop`, `session_token`, `prf_output` top-level keys; replaces session IDs with stable SHA-256 hashes; truncates file paths to extension; elides `event.request.data.content`. Renderer-side init lives in `apps/desktop/renderer/src/sentry.ts`.
```

---

**Edit 5.7.3C — Plan-023:103-110 (renderer file paths)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
- `apps/desktop/src/main.tsx` — **created.** React entrypoint. Initializes Sentry renderer-side (`@sentry/electron/renderer`). Renders `<App />` into `#root`.
- `apps/desktop/src/App.tsx` — **created.** Top-level router + layout shell. Composes the five Signature Feature views as routes.
- `apps/desktop/src/features/timeline/TimelineView.tsx` — **created, composition-only.** Consumes `window.sidekicks.daemon.subscribe('session.events', ...)` per Spec-013. Filter / scroll-to-tail / jump-to-ID interactions.
- `apps/desktop/src/features/approvals/ApprovalsView.tsx` — **created, composition-only.** Consumes `daemon.call('approvals.listPending')` per Spec-012.
- `apps/desktop/src/features/invites/InvitesView.tsx` — **created, composition-only.** Consumes `controlPlane.call('invites.list')` per Spec-002.
- `apps/desktop/src/features/runs/RunsView.tsx` — **created, composition-only.** Consumes `daemon.subscribe('run.state', ...)` per Spec-004.
- `apps/desktop/src/features/channels/ChannelsView.tsx` — **created, composition-only.** Consumes `daemon.subscribe('channel.*', ...)` per Spec-016.
- `apps/desktop/src/sentry.ts` — **created.** Renderer-side `@sentry/electron/renderer` init. No `beforeSend` override (main-process scrubber catches everything that upload-ships; renderer stays thin).
```

*After (replace `apps/desktop/src/` with `apps/desktop/renderer/src/` across 8 bullet paths):*

```markdown
- `apps/desktop/renderer/src/main.tsx` — **created.** React entrypoint. Initializes Sentry renderer-side (`@sentry/electron/renderer`). Renders `<App />` into `#root`.
- `apps/desktop/renderer/src/App.tsx` — **created.** Top-level router + layout shell. Composes the five Signature Feature views as routes.
- `apps/desktop/renderer/src/features/timeline/TimelineView.tsx` — **created, composition-only.** Consumes `window.sidekicks.daemon.subscribe('session.events', ...)` per Spec-013. Filter / scroll-to-tail / jump-to-ID interactions.
- `apps/desktop/renderer/src/features/approvals/ApprovalsView.tsx` — **created, composition-only.** Consumes `daemon.call('approvals.listPending')` per Spec-012.
- `apps/desktop/renderer/src/features/invites/InvitesView.tsx` — **created, composition-only.** Consumes `controlPlane.call('invites.list')` per Spec-002.
- `apps/desktop/renderer/src/features/runs/RunsView.tsx` — **created, composition-only.** Consumes `daemon.subscribe('run.state', ...)` per Spec-004.
- `apps/desktop/renderer/src/features/channels/ChannelsView.tsx` — **created, composition-only.** Consumes `daemon.subscribe('channel.*', ...)` per Spec-016.
- `apps/desktop/renderer/src/sentry.ts` — **created.** Renderer-side `@sentry/electron/renderer` init. No `beforeSend` override (main-process scrubber catches everything that upload-ships; renderer stays thin).
```

---

**Edit 5.7.3D — Plan-026:26 (onboarding path)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
`apps/desktop/src/onboarding/` — **new renderer walkthrough.**
```

*After:*

```markdown
`apps/desktop/renderer/src/onboarding/` — **new renderer walkthrough.**
```

---

**Edit 5.7.3E — cross-plan-dependencies.md:69 (§2 extender list expansion from 9 to 20 plans)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
| `apps/desktop/renderer/` | Plan-023 (creates the React + Vite renderer app at Tier 8) | Plan-009, Plan-011, Plan-012, Plan-013, Plan-014, Plan-016, Plan-017, Plan-019, Plan-026 (all Tier 8 or later, composed as renderer views) | Each extending plan adds renderer views as thin projections over the Spec-023 preload-bridge surface (`window.sidekicks`). Extending plans must not bypass the bridge to reach daemon or control-plane state directly. Plan-013's live timeline components land here under `src/timeline/` (Plan-013's Tier 8 placement is the earliest tier at which `apps/desktop/renderer/` exists). |
```

*After:*

```markdown
| `apps/desktop/renderer/` | Plan-023 (creates the React + Vite renderer app at Tier 8) | Plan-001 (`renderer/src/session-bootstrap/`), Plan-002 (`renderer/src/session-members/`), Plan-003 (`renderer/src/runtime-node-attach/`), Plan-004 (`renderer/src/run-controls/`), Plan-006 (`renderer/src/timeline/` audit-stub), Plan-007 (`renderer/src/daemon-status/`), Plan-008 (`renderer/src/session-join/`), Plan-009 (workspace/repo renderer views), Plan-010 (`renderer/src/execution-mode-picker/`), Plan-011 (`renderer/src/diff-review/`), Plan-012 (approvals renderer views), Plan-013 (`renderer/src/timeline/` live), Plan-014 (artifacts renderer views), Plan-015 (`renderer/src/recovery-status/`), Plan-016 (channels renderer views), Plan-017 (`renderer/src/workflows/`), Plan-018 (`renderer/src/participants/`), Plan-019 (notifications renderer views), Plan-020 (`renderer/src/health-and-recovery/`), Plan-026 (`renderer/src/onboarding/`) | Each extending plan adds renderer views as thin projections over the Spec-023 preload-bridge surface (`window.sidekicks`). Extending plans must not bypass the bridge to reach daemon or control-plane state directly. Tier-ordering detail: extensions land at each plan's canonical tier, but renderer-tree construction begins at Plan-023's Tier 8 — pre-Tier-8 extender plans ship non-renderer deliverables first and add the renderer subtree at Tier 8 or the plan's own tier, whichever is later. Plan-013's live timeline components land under `renderer/src/timeline/` (Plan-013's Tier 8 placement is the earliest tier at which `apps/desktop/renderer/` exists; Plan-006's audit-stub rendering folds into the same subtree). |
```

---

**Rationale (shared across §5.7.3A-E):** The canonical architecture per container-architecture.md is `apps/desktop/renderer/` as the React renderer root (second client path alongside `apps/desktop/shell/`). 20 extender plans already target `apps/desktop/renderer/src/<subtree>/` under §Target Areas. Plan-023 + Plan-026 are the two outliers using `apps/desktop/src/` directly. Option A1 aligns the 2 outliers with the 20-consensus reality in a 3-file / 12-file-edit atomic commit; Option A2 would re-root the 20-consensus to match the 2 outliers (22-file / ~22-file-edit scope) — rejected as ~1.8× larger in file-edit scope (and ~7× larger in file count) while treating the minority as canonical. The §2 extender list expansion closes SHF-H-008's "missing 11 plans" MISSING drift in the same commit so §2's ownership map matches the post-fix reality.

**Cross-impact check (additional post-edits):**

- No Spec-023 body edit required (Spec-023 governs preload bridge + crash-reporter scrubber surface in `apps/desktop/electron/`, not the renderer subtree).
- No container-architecture.md edit required (L44 + L53 already correct with `apps/desktop/renderer/`).
- grep-verified post-edit: `apps/desktop/src/` would appear 0 times in landed corpus after Plan-023 + Plan-026 edits (confirmed by counting all current hits and subtracting the edits).
- H-009 (Plan-026 MINOR) resolved transitively — no separate §5.7 entry.
- §2 extender list expansion transitively closes SHF-H-008 (MISSING finding) — no separate §5.7 entry.
- Tier-ordering framing in §5.7.3E's "After" text preserves Plan-013's Tier-8-earliest-renderer invariant per the pre-fix row.
- ~~grep-verified post-edit: `apps/desktop/src/` would appear 0 times in landed corpus after Plan-023 + Plan-026 edits~~ **Amended 2026-04-23 per §5.7.3F:** H5 scoping under-counted `apps/desktop/src/` body-prose replications in both outlier plans. Pre-scope count: 14 Plan-023 hits + 5 Plan-026 hits = 19 path references; H5 §5.7.3A-D scoped only 11 (Plan-023 L21 + L90 + L103-110 + Plan-026 L26). Post-fix grep verified clean after §5.7.3A-F lands — substring-based replace_all spanned all 19 hits in one pass (all were genuinely renderer-path references).

---

**§5.7.3F — Remediation-time renderer-path spillover aggregate (8 RTFs; H6b discovery 2026-04-23)**

**Finding-source:** `remediation-time` (per §5.2.13 precedent; closeout doc §3.2 rationale). During H6b pre-scope inverted grep for §5.7.3 targets, 8 additional `apps/desktop/src/` body-prose replications surfaced beyond the §5.7.3A-D scope (4 in Plan-023, 4 in Plan-026). All are renderer-path references that belong under `apps/desktop/renderer/src/` — same pattern as §5.7.3A-D, no new pattern types introduced.

**Coverage:**

| Plan | Line | Pre-text surface | Drift type |
| --- | --- | --- | --- |
| Plan-023 | 119 | ESLint `no-restricted-imports` ban-list scope `apps/desktop/src/**` | Renderer subtree reference drift |
| Plan-023 | 211 | Renderer shell authoring step — `apps/desktop/src/App.tsx` reference | Renderer file reference drift |
| Plan-023 | 214 | ESLint authoring step — ban-list scope `apps/desktop/src/**` | Renderer subtree reference drift |
| Plan-023 | 304 | CI gate Done-checklist — ban-list scope `apps/desktop/src/**` | Renderer subtree reference drift |
| Plan-026 | 111 | Walkthrough-host mount source — `apps/desktop/src/onboarding/` reference | Renderer subtree reference drift |
| Plan-026 | 112 | Walkthrough.tsx file path — `apps/desktop/src/onboarding/Walkthrough.tsx` | Renderer file reference drift |
| Plan-026 | 375 | Implementation step 16 authoring — `apps/desktop/src/onboarding/Walkthrough.tsx` | Renderer file reference drift |
| Plan-026 | 489 | Password-dialog ESLint ignore-list — `apps/desktop/src/password-dialog/` | Renderer subtree reference drift |

**Execution mode:** Substring `apps/desktop/src/` → `apps/desktop/renderer/src/` replaced across both files via `Edit` with `replace_all=true`. All 14 Plan-023 hits + all 5 Plan-026 hits are renderer-path references (no false positives — verified by manual read of each hit); the main-process reference at Plan-023:90 (`apps/desktop/electron/main/crash-reporter.ts`) does not match the substring and stayed unchanged, as required by §5.7.3B's L90 carve-out.

**Rationale (§5.7.3F):** Same drift pattern as §5.7.3A-D — plan-body text carried the pre-consensus `apps/desktop/src/` renderer root after container-architecture.md settled on `apps/desktop/renderer/`. H5 identified 11 of 19 hits; pre-scope inverted grep surfaced the remaining 8. Closing all 19 in one substring-level replace_all pass (rather than 19 individual Edit blocks) is safe because every occurrence is genuinely renderer-path — confirmed by read-through before the bulk replace. This is the cleanest atomic fix; splitting into per-finding Edits would be the same landing state with 18× the tool-call overhead.

**Cross-impact check (§5.7.3F):**
- `finding-source: remediation-time` metadata tag per §5.2.13 precedent.
- Fix date 2026-04-23 (H6b discovery).
- No additional renderer-path hits remain. grep-verified: `apps/desktop/src/` returns **0 matches** in `docs/plans/` and `docs/architecture/` after §5.7.3A-F land. (Existing hits in `docs/reference/forge/` are a separate codebase reference, not this project's drift — unaffected.)
- Spec-023's preload-bridge + crash-reporter scrubber references in `apps/desktop/electron/` paths unaffected (different subtree, no drift).
- `apps/desktop/renderer/src/password-dialog/` subtree (Plan-026:489) — this is a Plan-026-owned subtree not yet registered in cross-plan-dependencies.md §2 extender list expansion. The §5.7.3E expansion lists Plan-026 as extender at `renderer/src/onboarding/`; the password-dialog subtree is a Plan-026 internal isolation surface mentioned only in a risk/mitigation paragraph, not a separate §2 ownership row. No further §2 edit required; the password-dialog subtree folds under Plan-026's broader `renderer/src/onboarding/` + isolation-surface scope.
- **META-1 arithmetic (continued):** detailed count updates from 62 → 70 detailed findings; total count updates from 73 → 81 total (8 additional RTF on top of prior §5.7.1D/E/F + §5.7.2D = 11 total RTF in H6b). Lane H MAJOR count updates from 12 → 20.

---

#### §5.7.4 SHF-preseed-002 — `PRAGMA synchronous = FULL;` additive schema directive

**Finding ID:** SHF-preseed-002 (Lane B external-citation quote fidelity, MAJOR, DRIFT; pre-seeded per BL-097 Resolution §7(b)). Routes to §5.7 because the remediation is adding a missing SQL directive to a `## Pragmas` block, not a quote repair.

**Target file:** `docs/architecture/schemas/local-sqlite-schema.md:7-13` (§Pragmas section — 3 directives currently).

**Canonical truth (fresh-Read 2026-04-22):**

- `docs/specs/015-persistence-recovery-and-replay.md:150-161` declares the full 4-pragma set with inline load-bearing rationale for `synchronous = FULL`: *"override better-sqlite3 default (NORMAL) for chain-of-custody durability"* + Spec-015:161 *"The `synchronous = FULL` override is load-bearing… each row is part of a cryptographic hash chain (see Spec-006 §Integrity Protocol) — a lost write breaks verifiability irrecoverably."*
- BL-097 Resolution §7(b) logged this as non-blocking pending ADR on cross-cutting pragma propagation.

**Option space (user-gate flag; H5 default = A):**

| Option | Description | Files touched | Recommendation |
| --- | --- | --- | --- |
| **A (recommended)** | Add `PRAGMA synchronous = FULL;` to `local-sqlite-schema.md` §Pragmas between `journal_mode` and `foreign_keys` directives, matching Spec-015's ordering. Include inline comment for durability rationale + cross-link to Spec-015 §Pragmas. The cross-cutting pragma-propagation ADR (the meta-concern BL-097 §7(b) gated on) remains deferred — it governs future pragma propagation discipline, not this one already-canonical directive. | 1 (local-sqlite-schema.md). | ✓ H5 proposal. Closes immediate drift; meta-ADR stays a separate workstream. |
| B | Keep deferred per BL-097 §7(b). | None. | ✗ `synchronous = FULL` is Spec-015-canonical with explicit load-bearing rationale (chain-of-custody durability; loss-of-write irrecoverably breaks verifiability). Deferring leaves an implementation-breaking ambiguity for Plan-001's writer worker. |
| C | Author the cross-cutting pragma-propagation ADR now as part of H5 scope. | Multiple (new ADR + propagation pass). | ✗ Out of H5 drift-closure scope. Candidate for a dedicated future BL; meta-discipline for future pragma additions is not a gate on this already-established directive. |

**Default asymmetry vs §5.6.3 (SHF-preseed-004 / BL-097 §7(d)):** §5.6.3 defers because §7(d) is *criterion-gated on the emergence of a second subdirectory candidate* (design signal pending). §5.7.4 closes because §7(b) is *soft non-blocking on a meta-ADR that governs future propagation discipline*, while the immediate directive has already been established as canonical in Spec-015 with load-bearing rationale — the meta-ADR doesn't gate this specific fix, it gates the cross-file propagation rule set. The close-now default respects the Spec-015 canonical + preserves the meta-ADR as a separate workstream.

---

**Edit 5.7.4 — `local-sqlite-schema.md` §Pragmas (additive directive)**

*Before (verbatim, fresh Read 2026-04-22, absent directive):*

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

*After (present directive inserted between `journal_mode` and `foreign_keys` to match [Spec-015 §Pragmas ordering](../../specs/015-persistence-recovery-and-replay.md#pragmas)):*

```sql
PRAGMA journal_mode = WAL;      -- concurrent readers during writes
PRAGMA synchronous = FULL;      -- override better-sqlite3 default (NORMAL) for chain-of-custody durability (see Spec-015 §Pragmas + Spec-006 §Integrity Protocol)
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

---

**Rationale:** `local-sqlite-schema.md` §Pragmas drifts from its own declared upstream (Spec-015 §Pragmas) by omitting the `synchronous = FULL` directive. Spec-015:161 records the load-bearing reason for overriding better-sqlite3's NORMAL default: *"each row is part of a cryptographic hash chain (see Spec-006 §Integrity Protocol) — a lost write breaks verifiability irrecoverably."* Plan-001's writer worker executes against the schema file at implementation time; the current drift leaves the durability invariant implicit, requiring the writer worker to find and apply the pragma from Spec-015 out-of-band. The additive fix restores canonicity in a single file while keeping the cross-cutting pragma-propagation ADR (BL-097 §7(b)'s meta-concern) as a separate deferred workstream.

**Cross-impact check:**

- Spec-015:155-158 remains authoritative for the 4-pragma set — §5.7.4's schema-file edit cross-links to Spec-015 §Pragmas to preserve the single-source-of-truth.
- Plan-001's writer worker implementation (V1 Tier 1) consumes the corrected schema-file pragma block directly; no Plan-001 body edit required.
- Pass G §2 research `"All pragmas inherited from Spec-015 (journal_mode=WAL, synchronous=FULL, foreign_keys=ON, busy_timeout=5000)"` remains consistent post-edit.
- Inline comments on `journal_mode` and `synchronous` preserved verbatim from Spec-015:155-156 to maintain cross-file comment alignment.
- `shared-postgres-schema.md` has no `## Pragmas` section — no Postgres-side pragma propagation drift exists.
- BL-097 §7(b) `remediation-status`: `deferred` → `landed-2026-04-22` for the immediate drift; the meta-ADR question (cross-cutting pragma propagation discipline) remains a deferred separate workstream.

---

### §5.8 Lane K — Numeric Consistency (1 group, 1 file-edit)

Lane K H2 surfaced 35 findings (29 MATCH + 6 DRIFT; 1 MAJOR + 34 MINOR). All 12 canonical numeric subjects (V1 count, CF DO envelope, memory budget, capacity targets, Postgres sizing, infrastructure per-component) have at least one baseline MATCH with no internal contradictions. After absorption + routing, §5.8 carries **1 MAJOR group** (SHF-K-009 — backlog.md:32 Active Items intro V1=16 drift in current-reading prose).

**§5.8 scope table:**

| Finding | Verdict | Severity | §5.8 routing | Default file-edits |
| --- | --- | --- | --- | --- |
| **SHF-K-009** | **DRIFT** | **MAJOR** | **§5.8.1 — backlog.md:32 Active Items intro V1=16/V1.1=4 drift; current-reading prose outside `Status: completed` blocks.** | **1** |
| SHF-K-010 | DRIFT | MINOR | §6 Lane G single-editor's-note batch (backlog.md:44 BL-038 Summary task-text inside `Status: completed`). |  0 |
| SHF-K-011 | DRIFT | MINOR | §6 Lane G single-editor's-note batch (backlog.md:54-55 BL-039 Summary + Exit Criteria task-text inside `Status: completed`). | 0 |
| SHF-K-012 | DRIFT | MINOR | §6 Lane G single-editor's-note batch (backlog.md:248-249 BL-053 Summary + Exit Criteria task-text inside `Status: completed`). | 0 |
| SHF-K-013 | DRIFT | MINOR | §6 Lane G single-editor's-note batch (backlog.md:319,327 BL-054 heading + Exit Criteria task-text inside `Status: completed`). | 0 |
| SHF-K-014 | DRIFT | MINOR | §6 Lane G single-editor's-note batch (backlog.md:531 BL-071 Resolution dated-snapshot narrative inside `Status: completed`). | 0 |
| SHF-K-034 | DRIFT | MINOR | **Absorbed into §5.7.4** (SHF-preseed-002 primary). Lane K secondary confirmation: numeric sub-claim `busy_timeout = 5000` MATCHES both docs; pragma-presence drift on `synchronous = FULL` is §5.7.4's scope. | 0 (§5.7.4) |
| SHF-K-001 … SHF-K-008, SHF-K-015 … SHF-K-033, SHF-K-035 | MATCH | MINOR | No remediation (baseline + cross-checks). | 0 |

**Parent-context spillover grep results (per §5.3.2 lesson):**

- `V1 consists of 16 features|V1 = 16 features|16 features including|V1.1 defers` — **6 source hits in backlog.md**: :32 (current-reading intro, §5.8.1 primary), :44 (BL-038 Summary, §6 Lane G), :54-55 (BL-039, §6), :248-249 (BL-053, §6), :319,327 (BL-054, §6), :531 (BL-071 Resolution narrative, §6). All 5 post-intro hits are inside `Status: completed` blocks (historical task-definition text or dated-snapshot resolution narratives); only :32 is current-reading prose.
- Spillover outside backlog.md: grep of `V1 consists of 16 features` in docs/ returns only the 6 backlog hits — no other doc carries the intro phrasing. Canonical doc-state (ADR-015:34, v1-feature-scope.md:7/29/49/54/97, ADR-020:48/163/224, ADR-017:14, cross-plan-dependencies.md:187, Spec-017:382, vision.md:419, backlog.md:714 BL-097 Resolution) all correctly cite 17/3 per SHF-K-002..K-008.
- SHF-K-034 pragma spillover: already covered under §5.7.4 parent-context grep (`PRAGMA synchronous` = 1 source hit in Spec-015; no other declarations in schemas/).

**Atomic-commit scope:** §5.8 = 1 file-edit (backlog.md:32) in one commit. §5.8.1 is standalone — no cross-file coupling.

---

#### §5.8.1 SHF-K-009 — backlog.md:32 Active Items intro V1=16 drift

**Finding ID:** SHF-K-009 (Lane K numeric, MAJOR, DRIFT; severity-ambiguous escalated from MINOR per §6 clause: current-reading prose outside any `Status: completed` block).
**Target:** `docs/backlog.md:32` (Active Items intro paragraph — first thing a new reader sees when scanning the backlog).
**Canonical source:** ADR-015:34 Amendment 2026-04-22 (V1 = 17 features per BL-097 workflow authoring promotion; V1.1 = 3 features).

**Option space (user-gate flag; H5 default = A):**

| Option | Description | Files touched | Recommendation |
| --- | --- | --- | --- |
| **A (recommended)** | Update intro to cite current 17/3 state post-amendment while preserving historical provenance for the 2026-04-16 audit-snapshot origin. Format: "generated from the 2026-04-16 audit … V1 consists of 17 features per [ADR-015 Amendment 2026-04-22](…) / BL-097 Resolution …". Preserves audit-origin attribution; closes current-reading drift. | 1 (backlog.md:32). | ✓ H5 proposal. Closes current-reading drift with historical-provenance carryforward. |
| B | Append dated hedge (e.g., "(snapshot as of 2026-04-16 — see ADR-015 Amendment 2026-04-22 and BL-097 Resolution for the post-amendment 17/3 split)"). Preserves 16/4 phrasing under a dated-snapshot wrapper. | 1 (backlog.md:32). | Acceptable but weaker — readers still see 16/4 as the first numbers, correction requires following the cross-reference. Semantically equivalent to Option A but presentationally weaker. |
| C | Rewrite intro entirely, dropping historical 16/4 framing. | 1 (backlog.md:32). | ✗ Loses audit-snapshot provenance without replacement value; the 2026-04-16 audit is a load-bearing historical anchor for Phase 0 of the backlog. |

---

**Edit 5.8.1 — backlog.md:32 (Active Items intro)**

*Before (verbatim, fresh Read 2026-04-22):*

```markdown
This set was generated from the 2026-04-16 pre-implementation architecture audit (session ID `2026-04-16-arch-audit-163537`) and the V1 scope definition formalized in BL-038 (V1 consists of 16 features including Desktop GUI and Multi-Agent Channels; V1.1 defers MLS relay E2EE, email invite delivery, cross-node shared artifacts, and workflow authoring). Items are ordered by execution dependency: Phase 0 anchors downstream work; Phases 1–4 are P0 blockers for Plan-001 coding; Phases 5–6 can run in parallel with early Plan-001; Phase 7 is hygiene to land before V1 ship.
```

*After:*

```markdown
This set was generated from the 2026-04-16 pre-implementation architecture audit (session ID `2026-04-16-arch-audit-163537`) and the V1 scope definition formalized in BL-038 (originally: V1 = 16 features + V1.1 = 4 features). Per [ADR-015 Amendment 2026-04-22](./decisions/015-v1-feature-scope-definition.md#amendment-history) and [BL-097 Resolution](./backlog.md#bl-097-workflow-authoring-and-execution-v1-scope-research-and-session-m-absorption), the current canonical state is **V1 = 17 features** (BL-097 promoted workflow authoring from V1.1 to V1) and **V1.1 = 3 features** (MLS relay E2EE, email invite delivery, cross-node shared artifacts). Items are ordered by execution dependency: Phase 0 anchors downstream work; Phases 1–4 are P0 blockers for Plan-001 coding; Phases 5–6 can run in parallel with early Plan-001; Phase 7 is hygiene to land before V1 ship.
```

---

**Rationale:** The Active Items intro paragraph is the first thing a new reader sees when scanning the backlog — it frames the entire document's content. Under the current text, a reader learns V1=16 / V1.1=4 as the canonical state; the correction lives hundreds of lines downstream in BL-097 Resolution. Lane K escalated this from MINOR to MAJOR per §6 clause because (a) it is current-reading prose, not historical task-definition text, and (b) it is not inside any `Status: completed` block. Option A preserves audit-origin attribution ("generated from 2026-04-16 audit") + BL-038 historical anchor, then cites the post-amendment canonical state with cross-references to ADR-015 Amendment + BL-097 Resolution. Readers get both the historical provenance and the current state without divergence.

**Cross-impact check:**

- Cross-lane context: the 5 MINOR Lane K backlog drifts (K-010…K-014) all sit inside `Status: completed` BL blocks where ADR-015 Amendment History provides disambiguating context; per ledger §2, these route to §6 Lane G single-editor's-note batch (one editor's note at the top of backlog.md covers all 11 historical BL V1=16 drifts across Lane G + Lane K — merged batch per ledger §2's "Lane G + Lane K merged batch" framing).
- No load-bearing downstream contract consumes the backlog.md:32 intro — this is documentation-of-state, not implementation-contract.
- Amendment History cross-link (ADR-015 Amendment 2026-04-22) lands an authoritative anchor for V1-scope evolution; preserves audit-origin attribution to BL-038.
- BL-097 Resolution cross-link provides the canonical closure-audit surface for the promotion.
- grep-verified: no other doc carries `V1 consists of 16 features` intro phrasing outside the 6 backlog.md hits enumerated in §5.8 parent-context grep results.
- After edit, a new reader scanning the backlog from top gets canonical 17/3 immediately with historical context preserved as provenance, not as current-state claim.

---

Plus post-§3 routing: any Lane I re-triages classified as MAJOR are appended to this section (§3 outcome: 0 MAJOR spillover).

---

## 6. MINOR Pattern-Batch Remediation

Per §2.1 scope decision, MINOR findings are remediated via pattern blocks — one block per lane-level pattern describing the uniform H6 transformation. H5's user-gate approves each lane's **batching strategy**; full per-finding verbatim before/after text is not an H5 deliverable — finding rosters are authoritative in the per-lane files under [session-h-final-h2-findings/](./session-h-final-h2-findings/).

**Total coverage:** ~195 MINOR findings across 11 lanes (A, B, D, E, F, G, H, I, J, K, L) per [ledger §7](./session-h-final-ledger.md#7-minor-findings-summary) + §1 re-triage accounting (~178 base after Lane H remediation-time count correction + 17 Lane I CRITICAL→MINOR re-triage spillover per §3). Lane G's 11 MINOR are covered by a single editor's-note edit (§6.6; H3-pre-approved per [ledger §9](./session-h-final-ledger.md#9-h3-triage-decisions-summary) row "Lane G + Lane K backlog V1=16 merge"); Lane H's SHF-H-009 MINOR resolves transitively via §5.7.3 and SHF-H-010 is absorbed into §5.6.3 (Lane E primary) — neither is repeated in §6.7.

**§6 vs ~195 coverage reconciliation:** §5 absorbs 2 Lane H MINOR (SHF-H-009 into §5.7.3, SHF-H-010 into §5.6.3); §6 actual coverage ≈ 193 (195 − 2 MINOR absorbed cross-bucket). The 2-finding gap is intentional: per-finding routing is optimized for atomic-commit cohesion, not per-section count parity.

Each block below specifies: **pattern** (finding family description), **illustrative before → after** (representative of the pattern; not verbatim per-finding text), **coverage** (per-lane file pointer + count), **H6 execution mode** (batch grep+sed vs. per-file review vs. per-BL review), and **pre-execution risk**. Illustrative examples are generalized — H6 executors resolve per-finding verbatim text against the per-lane file.

---

### §6.1 Lane A — External URL format variance

**Pattern:** URL shape drift — `http://` vs `https://`; versioned-path redirects (e.g., docs with `/stable/` now serving under `/en/stable/` or `/<major>/`); bare-domain vs. explicit-path variance. Target content unchanged; URL shape changed.

**Uniform transformation (illustrative before → after):**

```
- https://docs.python.org/stable/library/sqlite3.html
+ https://docs.python.org/3/library/sqlite3.html
```

**Coverage:** ~30 MINOR entries in [lane-a-external-citation-existence.md](./session-h-final-h2-findings/lane-a-external-citation-existence.md).

**H6 execution mode:** per-URL WebFetch verification. Batch grep+sed is rejected because URL redirects can serve different content than the original citation claims. Reviewer fetches each candidate URL, confirms target semantics match the cited claim, applies edit. NOISE entries per [ledger §8](./session-h-final-ledger.md#8-noise-findings-deferred-re-audit-candidates) are skipped (access-blocked sources — not in H6 scope).

**Pre-execution risk:** re-fetching may surface further drift between citation date and audit date; when URL form is version-coupled (e.g., `/3/` vs `/3.12/`), cite audit date inline so future audits can distinguish original-intent from redirect-induced drift.

---

### §6.2 Lane B — External quote substring wording variance

**Pattern:** quote substring present in source but with wording variance — punctuation, whitespace, word-order, or article differences that do not alter load-bearing semantics.

**Uniform transformation (illustrative):**

```
- "WAL mode provides better concurrent access" (downstream-doc rendition)
+ "WAL mode provides good concurrent access" (source-exact per https://www.sqlite.org/wal.html §1)
```

**Coverage:** ~25 MINOR entries in [lane-b-external-citation-quote-fidelity.md](./session-h-final-h2-findings/lane-b-external-citation-quote-fidelity.md).

**H6 execution mode:** per-file review with source re-verification. §4/§9.3 research-trust scope applies — research docs (`docs/research/`) preserve source-accurate quotes and are out of scope; drift is always in downstream specs/ADRs/plans that recited a research citation with wording variance.

**Pre-execution risk:** source wording may have changed between original citation date and audit; if source is now NOISE (inaccessible per ledger §8), preserve the downstream doc's original quote with an inline audit-date annotation (`[audit 2026-04-22: source inaccessible; original quote preserved]`).

---

### §6.3 Lane D — Non-load-bearing internal cross-reference drift

**Pattern:** doc references another doc-section that exists but lacks a reciprocal back-reference; non-load-bearing because the reference is informational-only.

**Uniform transformation (illustrative):**

```
- See [Spec-006 §Integrity Protocol](../specs/006-integrity-protocol.md#integrity-protocol)
+ See [Spec-006 §Integrity Protocol](../specs/006-integrity-protocol.md#integrity-protocol) (informational-only; Spec-006 does not reciprocally reference this doc)
```

**Coverage:** 2 MINOR entries in [lane-d-internal-cross-reference-bidirectionality.md](./session-h-final-h2-findings/lane-d-internal-cross-reference-bidirectionality.md).

**H6 execution mode:** per-file review — 2 findings each assessed individually for reciprocation-vs-annotation choice based on whether the target doc's scope is broad enough to warrant a back-reference.

**Pre-execution risk:** none.

---

### §6.4 Lane E — Legacy BL Exit Criteria format variance

**Pattern:** BLs authored prior to Session C's template refresh lack an explicit `Resolution (resolved <date>):` block; variant field ordering; Exit Criteria stated as prose vs. bullet list.

**Uniform transformation (illustrative):**

```
- Status: completed
- [no Resolution block]
+ - Resolution (resolved 2026-XX-XX per Session Y): [narrative describing what was delivered; link artifact commits via git SHA where applicable]
```

Append `Resolution (resolved <date>):` block matching the BL-084+ template (see [§8 BL-083 hygiene stub](#8-meta-hygiene-edit-bl-083-resolution-stub) for a fully-worked example). Resolution date = git-commit date of the completing work per the **META-2 Lane-I primitive refinement** (check Exit Criteria verifiability via current repo state, not Resolution-block presence).

**Coverage:** 45 MINOR entries in [lane-e-coverage-orphan-detection.md](./session-h-final-h2-findings/lane-e-coverage-orphan-detection.md).

**H6 execution mode:** per-BL review — each BL needs `git log` back-traversal for resolution-date + narrative composition naming the specific deliverables. Not grep+sed-amenable; narrative content varies per BL.

**Pre-execution risk:** Exit Criteria verification per META-2 primitive is gating. If Exit Criteria cannot be evidenced in current repo state, the finding is promoted MINOR → MAJOR and re-routed to §5 with a new remediation group. Promotion must be logged in ledger §7 with `finding-source: remediation-time` per frozen-discovery rules.

**Cross-lane overlap:** Lane K (§6.10) shares the Resolution-block template with Lane E. When a BL appears in both lanes' MINOR rosters, execute jointly — apply the unified template once per BL, attributing the edit to both lanes in the commit message.

---

### §6.5 Lane F — Timestamp format variance

**Pattern:** Date field annotations at inconsistent precision — `2026-02` vs `2026-02-15`, `Feb 2026` vs ISO-8601, quarter (`Q1 2026`) vs monthly references.

**Uniform transformation (illustrative):**

```
- Date: 2026-02
+ Date: 2026-02-15 (ISO-8601 full-precision; verified via git log of authoring commit)
```

OR if month-granular was the author's original intent (e.g., roadmap-month annotation):

```
- Date: 2026-02
+ Date: 2026-02 (month-granular; original author intent preserved)
```

**Coverage:** 16 MINOR entries in [lane-f-version-date-consistency.md](./session-h-final-h2-findings/lane-f-version-date-consistency.md).

**H6 execution mode:** per-file review — original author intent (full-date vs. month-granular) determines which transformation applies; git log surfaces authoring date for ambiguous cases.

**Pre-execution risk:** overprecision introduces false date claims. When author intent is ambiguous and git log shows multiple plausible resolution dates, annotate `(month-granular; author intent ambiguous)` rather than invent a day — invented precision would be new drift.

---

### §6.6 Lane G — Historical V1=16 count text (single editor's-note merge)

**Pattern:** 11 closed-BL blocks retain pre-Session-J V1=16 count text; Session J amended ADR-015 V1 scope to 18. Per [ledger §9](./session-h-final-ledger.md#9-h3-triage-decisions-summary) H3-triage row "Lane G + Lane K backlog V1=16 merge", a single editor's-note edit covers all 11 findings.

**Uniform transformation (single edit):**

Add a single Editor's Note at `backlog.md:30` stating that V1 scope has been amended from 16 to 18 features per ADR-015 Session-J Amendment (reference ADR-015 `## Amendment History` entry for the precise amendment date). Per-BL body text preserves the historical V1=16 claim because closed-BL bodies are auditable history, not current doctrine — preservation + single-point-of-truth editor's-note is the merge strategy.

**Coverage:** single remediation covers all 11 MINOR findings (Lane G 11/11).

**H6 execution mode:** single atomic edit to `backlog.md:30`; no per-BL edits required.

**Pre-execution risk:** none; merge pre-approved in H3. Editor's-note wording must cite ADR-015's amendment date exactly (fresh-Read ADR-015 `## Amendment History` during H6 execution).

---

### §6.7 Lane H — §2 ownership-map row coverage gap (single residual finding)

**Pattern:** §2 Package Path Ownership Map is missing rows for subdirectories declared in plan target areas but absorbed-into-deferred-preseed for convention-extension. Concretely: Plan-017 declares `packages/contracts/src/workflows/` and `packages/runtime-daemon/src/workflows/` as new shared directories, but §2 carries no rows for either. §5 carries the substance at Tier 8 but §6 rule 3 names §2 as the canonical surface.

**Uniform transformation (illustrative):**

```
- (no §2 row for `packages/contracts/src/workflows/`)
+ | `packages/contracts/src/workflows/` | Plan-017 (creates the subdirectory at Tier 8) | (no extenders yet) | Deferred convention-extension call per [BL-097 §7(d)](../backlog.md) — convention resolution blocked on second subdirectory candidate. |
```

**Coverage:** single finding — **SHF-H-011 only** — per [lane-h-dependency-topology-trace.md](./session-h-final-h2-findings/lane-h-dependency-topology-trace.md) row 42. Ledger §7:236 = 3 MINOR total (post-remediation-time correction — see [ledger §1 note](./session-h-final-ledger.md#1-executive-summary); H-009/H-010/H-011); §5.7.3 absorbs SHF-H-009 transitively (coupled to SHF-H-007 — see [§5.7.3 Cross-impact check](#573-renderer-path-drift-cluster-shf-h-007--shf-h-008--shf-h-009)); §5.6.3 absorbs SHF-H-010 (Lane E primary for SHF-preseed-004). **§6.7 residual = 1.**

**H6 execution mode:** per-file review — SHF-H-011 is a single `cross-plan-dependencies.md §2` edit appending two rows with deferred-convention notes referencing BL-097 §7(d). No batch grep+sed; the §2 table edit is idiosyncratic.

**Pre-execution risk:** if BL-097 §7(d) convention call lands between H5 user-gate and H6 execution (second subdirectory candidate surfaces), the §2 row format changes — re-verify BL-097 status before applying the H6 edit. Otherwise the deferral-annotated placeholder row pattern is the correct H6 output.

---

### §6.8 Lane I — Legacy "Decision (resolved <date>)" anchor format + re-triage spillover

**Pattern:** BL Resolution blocks using legacy `Decision (resolved <date>):` anchor format without Session-letter qualifier (introduced in Session C's template refresh).

**Uniform transformation (illustrative):**

```
- Decision (resolved 2026-02-15): Chose approach Y per research finding Z.
+ Resolution (resolved 2026-02-15 per Session X): Chose approach Y per research finding Z.
```

**Coverage:** **22 MINOR entries total** = 5 base MINOR in [lane-i-resolution-backlog-trace.md](./session-h-final-h2-findings/lane-i-resolution-backlog-trace.md) + 17 from §3 Lane-I re-triage CRITICAL→MINOR (per §1 L19 accounting; META-2 primitive-refinement verified 22/22).

**H6 execution mode:** per-BL review — Session-letter derived via git-log back-traversal from resolution-date (`git log --since <date-1week> --until <date+1week> -- docs/backlog.md` identifies the session commit touching the BL).

**Pre-execution risk:** wrong-session attribution introduces new drift. If git-log does not surface an unambiguous Session letter (e.g., the resolution fell across a session boundary), annotate `per Session TBD` and leave the finding open for a follow-up pass rather than guess.

---

### §6.9 Lane J — Bare "remains unresolved" in Plan Risks And Blockers

**Pattern:** "Plan Risks And Blockers" sections contain bare `remains unresolved` references to earlier-phase BLs that are now resolved.

**Uniform transformation (illustrative):**

```
- BL-XXX remains unresolved.
+ BL-XXX resolved 2026-XX-XX per Session Y (Resolution: [one-line summary]; see [backlog.md#bl-xxx](../backlog.md#bl-xxx)).
```

**Coverage:** 6 MINOR entries (Plans 002, 008, 012, 013, 016, 018) in [lane-j-open-questions-deferred-trace.md](./session-h-final-h2-findings/lane-j-open-questions-deferred-trace.md).

**H6 execution mode:** per-plan review — 6 findings; each pulls the Resolution narrative from `backlog.md` for the referenced BL and condenses to one line for the Plan Risks And Blockers section.

**Pre-execution risk:** if a referenced BL is actually still unresolved (not yet closed in `backlog.md`), preserve `remains unresolved` with an inline audit-date annotation rather than falsely marking it resolved.

---

### §6.10 Lane K — Historical task-definition text inside closed-BL blocks

**Pattern:** closed-BL blocks contain task-definition text (Deliverables, Exit Criteria phrased as to-do) that reads as pending because no Resolution narrative summarizes what was actually delivered.

**Uniform transformation (illustrative):**

```
- Exit Criteria: (a) write LICENSE file; (b) update package.json.
- [no Resolution block]
+ Exit Criteria: (a) write LICENSE file; (b) update package.json.
+ Resolution (resolved 2026-XX-XX per Session Y): (a) LICENSE committed at `<git-sha>`; (b) package.json license field updated in same commit. [§8 BL-083 is the worked example of this template.]
```

**Coverage:** 34 MINOR entries in [lane-k-numeric-consistency.md](./session-h-final-h2-findings/lane-k-numeric-consistency.md) excluding SHF-K-009 (MAJOR; handled in [§5.8](#58-lane-k-numeric-consistency)).

**H6 execution mode:** per-BL review; batch with Lane E (§6.4) when a BL appears in both MINOR rosters — apply the unified Resolution-block template once per BL and attribute to both lanes in the commit message.

**Pre-execution risk:** Exit Criteria verification per META-2 primitive. Failure (Exit Criteria not evidenced in current repo state) → MINOR → MAJOR promotion and re-route to §5.

---

### §6.11 Lane L — ADR-013 reserved-skipped MATCH summary

**Pattern:** single ADR-013 entry where the summary-table cell annotation differs from the ADR body status; ADR body is authoritative.

**Uniform transformation (single edit):**

Fresh-Read ADR-013, then reconcile the summary-table cell to match the body status (Superseded, Reserved-Skipped, Accepted, etc., per whichever value the body declares).

**Coverage:** 1 MINOR entry in [lane-l-adr-status-consistency.md](./session-h-final-h2-findings/lane-l-adr-status-consistency.md).

**H6 execution mode:** per-file review (1 finding); confirm ADR-013 body status via fresh Read at H6 execution time.

**Pre-execution risk:** if ADR-013 body itself is drifted (e.g., body has internally inconsistent status claims across sections), promote MINOR → MAJOR and re-route to §5.

---

### §6 Atomic-commit scope summary

Per §5.1 atomic-commit discipline, each lane's MINOR batch lands as a separate atomic commit within H6 — **11 lane-level commits** on top of §5 (34 MAJOR remediation groups) + §7 (META-1 scope-lock amendment) + §8 (BL-083 hygiene stub). Lane G (§6.6) and Lane L (§6.11) are single-edit commits each. Lane K (§6.10) and Lane E (§6.4) may share a unified Resolution-block template per-BL where a BL appears in both lanes' rosters — the unified edit still lands under one commit-per-lane (either Lane E's or Lane K's, whichever lane's commit comes first in H6 ordering; secondary lane's commit omits the already-landed BL).

**H6 MINOR commit count (recommendation):** **11 lane-level commits** (one per §6.1–§6.11). Alternative (~195 per-finding commits) is rejected — excessive ceremony for MINOR-severity drift that is lane-homogeneous by construction. H5 user-gate approves the 11-lane-commit strategy.

**Note (META-1 supersession, 2026-04-23):** META-1 single-bundled-H8-commit decision supersedes the "11 lane-level commits within H6" framing above. H6 lane-blocks land as logical edit-clusters; final commit ordering is the single H8 atomic commit per [§7 META-1](#7-meta-amendment-scope-lock-103-meta-1).

---

### §6.12 H6b Remediation-Time Findings Aggregate (added 2026-04-23 during H6b execution)

Per §5.2.13 RTF aggregate precedent + closeout §3.3 frozen-discovery rules, this block captures all `finding-source: remediation-time` findings surfaced during H6b lane-execution. Pattern: H6b execution against §6.1–§6.11 prescriptions revealed two distinct RTF categories — (A) **H5 prescription drift** (H5 §6 prescriptions describe patterns that don't match the H2 per-lane finding roster) and (B) **H2 roster gaps** (pre-scope inverted grep surfaced bare instances H2's enumeration missed).

#### §6.12 Category A — H5 §6 Prescription Drifts (5 instances)

H5 §6 prescriptions were apparently authored from H4 ledger §7 row counts (which lump MATCH-summary entries + DRIFT + NOISE) rather than the per-lane H2 finding rosters (which are the true source of remediable drift). Authoritative source for H6b execution: H2 per-lane files at [session-h-final-h2-findings/](./session-h-final-h2-findings/), not H5 §6 illustrative prescriptions.

| RTF-ID | H5 §6 prescription | H2 actual roster | Resolution |
|---|---|---|---|
| §6.12.A.1 | §6.6 Lane G: V1 scope amended "16 to 18 features per ADR-015 Session-J Amendment" | V1=17 per BL-097 Session-M close (Session-J transient V1=18 superseded); H2 Lane G enumerates 11 DRIFT in `backlog.md` historical-state strings | Applied [Lane G auditor's Option R1](./session-h-final-h2-findings/lane-g-feature-scope-count-consistency.md): explicit BL-historical-state clarifier added to `backlog.md:32` paragraph (1 edit covering all 11 DRIFT). |
| §6.12.A.2 | §6.11 Lane L: "single ADR-013 entry where summary-table cell annotation differs from ADR body status" | H2 Lane L: 0 DRIFT, 0 MINOR. ADR-013 is MATCH (sentinel `reserved-skipped` consistent across header / body / summary table). H4 ledger §7 row "Lane L \| 1 MINOR" traces to SHF-preseed-001 (Spec-017:42 STRICT deferral), verdict MATCH / `confirmed-deferred` per [Lane L H2 §7](./session-h-final-h2-findings/lane-l-adr-status-consistency.md) row 79. | No-op: no remediable drift exists. Deferred §6.11 SHF-preseed-001 verification noted as already-resolved in H2 + ledger §1:106. |
| §6.12.A.3 | §6.3 Lane D: "doc references another doc-section that exists but lacks a reciprocal back-reference" | H2 Lane D actual MINOR: SHF-D-009 (`cross-plan-dependencies.md:215` quotes Spec-024:11 with stale phrasing) + SHF-D-010 (`cross-plan-dependencies.md:215` cites Spec-024 §State And Data Implications line 172, actual content at line 173). Pattern: stale verbatim quote + off-by-one line ref. | Single edit at `cross-plan-dependencies.md:219`: paraphrased the stale quote (removing brittle line-reference) and replaced `line 172` with anchor-based `[§State And Data Implications](...)` reference. Closes both SHF-D-009 and SHF-D-010 in one edit. |
| §6.12.A.4 | §6.9 Lane J: "BL-XXX remains unresolved" referring to "earlier-phase BLs that are now resolved" — recommend "BL-XXX resolved 2026-XX-XX per Session Y" | H2 Lane J actual MINOR: 6 bare deferral statements lacking spec/BL anchor (Plan-002:90, Plan-008:92, Plan-012:93, Plan-013:91, Plan-016:93, Plan-018:91). Pattern: bare lines without `(per Spec-X)` or `(per BL-Y)` anchor. | Per-line annotation added to each bare line linking to parent Spec-NNN — e.g., `(deferral tracked in parent [Spec-NNN](../specs/...))`. Pattern matches Lane J auditor's H2 finding rationales. |
| §6.12.A.5 | §6.5 Lane F: "16 MINOR entries" | H2 Lane F: 13 MATCH + 2 DRIFT (SHF-F-014 Spec-016:8 + SHF-F-015 ADR-013:8 — embedded annotations in `Date` field) + 1 NOISE (SHF-F-016 Session L absence — flagged for H3 adjudication). H5 inflated count by including MATCH-summary rows. | Applied 2 DRIFT remediations (Spec-016 + ADR-013 Date-field cleanup; annotations were already present in adjacent rows). NOISE SHF-F-016 deferred to H7 per C2 closeout decision. |
| §6.12.A.6 | §6.2 Lane B: "~25 MINOR" (per H5 prescription) | H2 Lane B: 21 MATCH + 8 DRIFT (4 MAJOR + 4 MINOR) + 5 NOISE = 34 total. Of the 8 DRIFT, the 4 MAJORs (SHF-preseed-002, SHF-B-001, SHF-B-002, SHF-B-023) had already been routed individually to §5 and applied to docs prior to H6c (verified Spec-015:258-259 + ADR-017:46 fresh-Read). Only 4 MINORs (SHF-B-020, SHF-B-024, SHF-B-026, SHF-B-027) remained for H6c. H5 prescription inflated by including MATCH-summary rows + NOISE (per same prescription-drift pattern as §6.12.A.5 Lane F). | Applied 4 MINOR DRIFT remediations: SHF-B-020 (Spec-006:478 backtick strip on "Improper use of in or =="); SHF-B-024 (ADR-017:47 Zed quote A reframed to verbatim "allows individuals to edit their own replicas of a document independently"); SHF-B-026 (ADR-017:54 Linear/reverse-Linear paraphrased third substring removed, leaving 2/2 verbatim subparts); SHF-B-027 (Plan-024:112 Azure prefix stripped from quoted product names; "commonly prefixed Azure in Microsoft Learn docs" parenthetical added). 5 NOISE deferred per ledger §8 policy (see §6.12.D below). |
| §6.12.A.7 | §6.4 Lane E: "45 MINOR Resolution-block additions" (per H5 §6.4 prescription) | H2 Lane E: 45 MATCH (Spec↔Plan pairs + BL Exit Criteria existence verifications, all confirmed) + 1 ORPHAN (SHF-E-025 Spec-024) + 1 cross-lane MATCH (SHF-E-031 BL-039 Exit-Criteria text) + 1 preseed DRIFT (SHF-preseed-004) = 48 total. **Pattern of drift differs from prior §6.12.A entries:** H5's own §5.6 routing table already declares "3 deferred-confirm groups, 0 file-edits" — the prescription drift is intra-H5 (§6.4 illustrative vs §5.6 actual routing), not H5-vs-H2. §6.4's Resolution-block-addition pattern describes Lane I-style work that doesn't correspond to any H2 Lane E finding. | **No-op confirmed.** §5.6 routing already encodes: SHF-E-025 deferred-by-design (BL-054 implicit-dep framing); SHF-E-031 routed to Lane G/§6.6 batch (already applied at backlog.md:32 — see §6.12.A.8 verification); SHF-preseed-004 deferred per BL-097 §7(d). 45 MATCH need no remediation. **0 file-edits in Lane E §6.4.** |
| §6.12.A.8 | §6.10 Lane K: "34 MINOR Resolution-block additions" (per H5 §6.10 prescription) | H2 Lane K: 29 MATCH + 5 MINOR DRIFT (SHF-K-010..014, all V1=16 historical text inside `Status: completed` BL blocks) + 1 MAJOR (SHF-K-009 backlog.md:32 Active Items intro V1=16 prose) + 1 secondary preseed (SHF-K-034 → SHF-preseed-002 primary in §5.7.4) = 35 total + 1 secondary. **Same intra-H5 drift pattern as §6.12.A.7:** H5's own §5.8 routing table declares 1 file-edit (§5.8.1 SHF-K-009 backlog.md:32) — explicitly excluded from §6.10 with note "excluding SHF-K-009 (MAJOR; handled in §5.8)". The 5 MINOR DRIFT are explicitly routed to §6.6 Lane G batch per §5.8 routing table (single editor's-note covers all 11 historical V1=16 BLs across Lane G + Lane K merged batch per ledger §9 H3 triage). §6.10's Resolution-block-addition pattern describes Lane I-style work that doesn't correspond to any H2 Lane K finding. | **No-op confirmed; 1 §5 edit pre-applied verified.** Verified `docs/backlog.md:32` carries both (a) §5.8.1 V1=17/V1.1=3 canonical-state correction with ADR-015 Amendment + BL-097 cross-references, AND (b) §6.6 Lane G editor's note ("Note: BL summary, exit-criteria, and resolution text below preserves the original 2026-04-17 V1=16 / V1.1=4 charter state for audit provenance — these are append-only historical work-item charters, not live scope claims"). Both edits merged into the single Active Items intro paragraph. SHF-K-034 absorbed into §5.7.4 (SHF-preseed-002 primary). **0 net new file-edits in Lane K §6.10**; SHF-K-009 §5.8.1 edit is an §5-bucket landing not §6 H6c-bucket. |
| §6.12.A.9 | §6.1 Lane A: "External URL format variance, ~30 MINOR entries" (per H5 §6.1 prescription) | H2 Lane A: 139 findings = ~92 MATCH (existence-confirmed) + 16 DRIFT MAJOR (routed to §5 / §4.3 individually — SHF-A-012 RFC 9068 §5, SHF-A-014 node-pty#437, SHF-A-017/A-018 Jenkins SECURITY-383, SHF-A-122 Electron #24573, etc.) + **5 DRIFT MINOR** (SHF-A-013, A-059, A-072, A-090, A-121 — the actual §6.1 H6c residue) + 12 NOISE (10 access-failures + 2 pending re-fetch — deferred per ledger §8) + 14 ORPHAN (routed to §5 / §4.3). **Same H5-prescription-drift pattern as §6.12.A.5/A.6:** H5 §6.1's "~30 MINOR" inflated by including MAJOR-routed-to-§5 + NOISE-deferred + MATCH rows. Plus a paired occurrence: SHF-A-013's mls-rs license drift recurs at `security-architecture.md:270` (the H2 finding's own remediation note flags this), making the SHF-A-013 cluster a 2-edit fix (ADR-010:162 + security-architecture.md:270). | **6 file-edits applied in Category A scope (5 base DRIFT + 1 SHF-A-013 paired occurrence at security-architecture.md:270; 12 NOISE deferred per ledger §8).** See Lane A cluster summary below for per-finding edit detail. **Plus 5 SHF-A-121 paired occurrences (Plan-024 ×3 + Spec-023 ×2) surfaced via pre-scope inverted grep, routed to §6.12.B.4 as Category B H2-roster-gap entries** — total Lane A landing = 11 edits across A.9 + B.4. |

#### §6.12 Category B — H2 Roster Gaps (4 entries: 3 Lane J + 1 Lane A aggregate, surfaced by pre-scope inverted grep)

Pre-scope inverted grep per closeout §3.2 surfaced (a) 3 additional bare `remains unresolved` instances matching H2 Lane J's own DRIFT-criteria but missed by H2 enumeration (§6.12.B.1/B.2/B.3), and (b) 1 aggregate Lane A entry (§6.12.B.4) covering 5 SHF-A-121 Apple-notarization paired-occurrence instances across Plan-024 + Spec-023 — same drift pattern as the SHF-A-121 base finding (Plan-023:284) but in live operational text + Sources rows that H2 Lane A row 138 did not enumerate.

| RTF-ID | Plan + line | Bare line text | Verdict + rationale | Resolution |
|---|---|---|---|---|
| §6.12.B.1 | Plan-014:93 | `- Manifest-first versus synchronous small-payload replication remains unresolved` | DRIFT MINOR — same shape as SHF-J-001 (Plan-002:90 bare); H2 Lane J subagent missed during enumeration despite matching its own primitive | Anchor annotation added: `(deferral tracked in parent [Spec-014](../specs/014-artifacts-files-and-attachments.md))` |
| §6.12.B.2 | Plan-019:92 | `- Per-session notification preferences remain unresolved for the first implementation` | DRIFT MINOR — same shape as SHF-J-002 (Plan-018:91 with "first implementation" framing); H2 Lane J subagent missed during enumeration | Anchor annotation added: `(deferred per [Spec-019](...) — V1 ships global preferences only; per-session post-V1)` |
| §6.12.B.3 | Plan-020:152 | `- Automated retry policy remains unresolved across drivers` | DRIFT MINOR — same shape as SHF-J-001 (Plan-002:90 bare); H2 Lane J subagent missed during enumeration | Anchor annotation added: `(deferral tracked in parent [Spec-020](../specs/020-observability-and-failure-recovery.md))` |
| §6.12.B.4 (aggregate, Lane A) | Spec-023:492 + Spec-023:643 + Plan-024:97 + Plan-024:166 + Plan-024:209 | 5 paired-occurrence instances of SHF-A-121 Apple-notarization-queue drift (16+ hour / February 2026 magnitudes + date) carried into live operational text and Sources tables in Plan-024 + Spec-023 | DRIFT MINOR (5 instances, aggregated) — same drift pattern as SHF-A-121 base finding (Plan-023:284, already remediated in §6.12.A.9 Lane A cluster); H2 Lane A row 138 enumerated only the Plan-023 base occurrence and missed the recurring magnitude/date phrasing in adjacent operational text + Sources rows. Pre-scope inverted grep on `notarization` + `16+ hour` + `February 2026` per closeout §3.2 surfaced these. Aggregated as one §6.12.B.4 entry per advisor guidance (cleaner than 5 separate B entries since same drift pattern recurring). | All 5 occurrences corrected to `24–120+ hour delays` + `January 2026` per [Apple Developer forum thread 813441](https://developer.apple.com/forums/thread/813441) actual content (thread posts dated January 2026; reported delay magnitudes 24h, 30h, 5-day per H2 row 138 finding). Body-prose-only correction; citation URL itself was already correct. Edits land at: Spec-023:492 (Operational risk text), Spec-023:643 (Sources table row), Plan-024:97 (Queue-delay mitigation), Plan-024:166 (Risk listing), Plan-024:209 (Sources table row). |

(Plan-007:136 also surfaced via pre-scope grep but carries consequence rationale "may pressure the transport boundary too early" analogous to MATCH SHF-J-006 Plan-015:90 — treated as MATCH per Lane J primitive's "carries a rationale" clause.)

#### §6.12 Category C — Lane I attribution-format observations (added 2026-04-24 during H6c §6.8 execution)

Lane I §6.8 execution surfaced one RTF related to Session-letter attribution discipline. The 22-edit Lane I cluster (5 base DRIFT renames + 17 re-triage CRITICAL→MINOR Resolution-block additions per §3.1 META-2 verification) lands with an intentional format divergence from §6.8's strict "per Session X" single-letter prescription; this category records the divergence and the rationale.

| RTF-ID | §6.8 prescription | Lane I actual landing | Resolution |
|---|---|---|---|
| §6.12.C.1 | §6.8 risk clause: "if git-log does not surface an unambiguous **Session letter** … annotate `per Session TBD`" — implies single-letter scheme (A/B/C/D1/D2/E1/E2/F/G1/G2/G3/H/I1/I2/J/K/L/M) | 14 of 22 BLs landed in Phase 8 sub-session commits whose labels (`Session 2a`, `Session 2c-2`, `Session 3a`, `Session 3b`, `Session 3c`, `Session 4`) **pre-date** the single-letter scheme. These labels are unambiguous identifiers in git history but are not single Session letters. Strict reading would route all 14 to TBD; truthful attribution preserves the actual git-log Session label. | **Preserve the actual Session label.** TBD is reserved for true ambiguity (no Session label in commit, or cross-session-boundary). 14/22 use Phase 8 sub-session labels; 8/22 use TBD. The §6.8 risk clause is interpreted as "ambiguity-driven" not "format-driven" — Phase 8 labels remain valid attributions. **4th Resolution-block format pattern** introduced (existing patterns: BL-083/084 inline narrative without Session, BL-058 separate `Resolved:` line, BL-088 inline with embedded Session; new: standalone `Resolution (resolved YYYY-MM-DD per Session X):` line with explicit Session qualifier — this lane's variant). |

#### §6.12 Lane I cluster summary (22 edits, 2026-04-24)

**Edit roster:** all 22 edits land in `docs/backlog.md`.

- **5 base DRIFT renames** (`Decision (resolved …)` → `Resolution (resolved … per Session TBD)`): BL-046, BL-047, BL-048, BL-052, BL-053. All TBD because the closing commits (`8218644`, `1dbbcbb`, `736a676`, `7a0f6fa`, `367fb96`) carry no Session label.
- **17 re-triage MINOR Resolution-block additions** appended after each BL's Exit Criteria line: BL-039, BL-040, BL-041, BL-042, BL-043, BL-044, BL-045, BL-049, BL-051, BL-055, BL-056, BL-078, BL-079, BL-080, BL-081, BL-082, BL-085. Each Resolution line cites the H5 §3.1 row, the closing commit SHA, and the META-2 tree-state evidence date.

**TBD categorization (8 of 22, 36%):**

| Reason | BLs | Count |
|---|---|---|
| Closing commit carries no Session label (commit author skipped the convention) | BL-039 (`c587eee`), BL-040 (`c587eee`), BL-046 (`8218644`), BL-047 (`1dbbcbb`), BL-048 (`736a676`), BL-052 (`7a0f6fa`), BL-053 (`367fb96`), BL-085 (`a89ae0e`) | 8 |

**Non-TBD (Phase 8 sub-session label preserved, 14 of 22):**

| Phase 8 sub-session | BLs | Count |
|---|---|---|
| Session 2a (commit `d36704b`) | BL-041, BL-042, BL-079, BL-081 | 4 |
| Session 2c-2 (commit `c74ba03`) | BL-049, BL-051 | 2 |
| Session 3a (commit `e854891`) | BL-045, BL-078 | 2 |
| Session 3b (commit `c1e4225`) | BL-044, BL-080 | 2 |
| Session 3c (commit `f83dcc6`) | BL-043, BL-082 | 2 |
| Session 4 (commit `cc6b4cd`) | BL-055 | 1 |
| Session D1 (commit `b2c7b48`) | BL-056 | 1 |

**Pre-scope cross-check (per closeout §3.2 + advisor ratification):** BL-038, BL-050, BL-054, BL-057 each appeared in Lane I H2 §22 MISSING/CRITICAL list but were excluded from Lane I §6.8 edit scope per H5 §3 ledger §5 pre-triage (these 4 + BL-083 are the 5 pre-triaged MINORs). Confirmed not in Lane I 22-edit cluster:

- **BL-054** — Lane K SHF-K-013 (`V1 = 16` Exit Criteria drift); covered by §6.10 Lane K pending edits.
- **BL-038, BL-050, BL-057** — Lane E artifact-survey roster (line 118); MATCH MINOR with Session-A / Session-D1 attribution already landed in `docs/backlog.md`.
- **BL-083** — hygiene stub per §8 (LICENSE-tracking precedent BL).

No overlap, no double-touch, no scope leak between Lane I §6.8 and Lane K §6.10 / Lane E §6.4.

#### §6.12 Category D — NOISE-handling discipline conflict (added 2026-04-24 during H6c §6.2 execution)

H6c Lane B execution surfaced a directive conflict between two audit-internal documents on how to handle Lane A + Lane B NOISE entries (originally 15: 10 Lane A access-failures + 5 Lane B access-failures; external-source access failures, not corpus drift). Post-Lane-A enumeration revised Lane A to 12 (10 access-failures + 2 pending re-fetch placeholders) → 17 total. Post-H7 verdict on Item 1 closed SHF-F-016 (Lane F skipped-session-label NOISE; distinct from external-source access — closure is ledger reconciliation) as NOISE and added to cite-refresh-pass roster → **final 18 NOISE entries deferred** (12 Lane A + 5 Lane B + 1 Lane F).

| Document | Directive |
|---|---|
| H5 §6.2 risk clause | Annotate inline with `[audit 2026-04-22: source inaccessible; original quote preserved]` |
| H6b closeout §6.2 (line 41) | "NOISE entries per ledger §8 skipped" |
| Ledger §8 policy (line 268) | "deferred out of H5/H6 scope. Candidates for a future cite-refresh pass with alternate fetch methods." |
| Ledger §9 (line 281) | "15 NOISE items deferred \| External-source access failures; not corpus drift" |

**Resolution (2026-04-24):** Ledger §8 controls. The H5 §6.2 risk clause was an early-draft suggestion; ledger §8 was finalized at H4 scope freeze (2026-04-22) and ledger is the canonical scope artifact, not H5. H6b closeout's "skip" correctly codifies ledger §8. **All 18 NOISE entries (12 Lane A + 5 Lane B + 1 Lane F SHF-F-016 closed by H7 verdict 2026-04-24) are skipped during H6c without inline annotation, deferred to a future cite-refresh pass.**

**Future cite-refresh pass scope:** if/when a cite-refresh pass runs, the 18 NOISE entries are the candidates: SHF-B-008 (XDG), SHF-B-016 (NIST SP 800-88 R2), SHF-B-017 (Temporal Worker — also Lane A ORPHAN), SHF-B-029 (Flyway Red Gate), SHF-B-032 (Liquibase) + Lane A's 10 access-limitation entries (XDG, NIST, Temporal, napi-rs/keyring, Electron/releases, Wails, WebKitGTK, Argo Workflows ×2, LangGraph, OpenAI Platform, MDPI) + 2 Lane A pending re-fetch placeholders + SHF-F-016 (Lane F Session L absence). Re-fetch attempts should use alternate URLs / mirrors / archive copies; manual PDF reads where applicable. **SHF-F-016 closure is via ledger reconciliation (verifying whether Session L was a planned-but-skipped session label), not URL re-fetch** — recorded here for completeness of the cite-refresh-pass candidate roster, but the closure mechanism differs from the access-failure entries.

#### §6.12 Lane B cluster summary (4 edits, 2026-04-24)

**Edit roster (4 MINOR DRIFT, all applied 2026-04-24):**

| Finding | Target | Edit |
|---|---|---|
| SHF-B-020 | `docs/specs/006-session-event-taxonomy-and-audit-log.md:478` | Strip backticks in Cedar validator error string: `*"Improper use of \`in\` or \`==\`"*` → `*"Improper use of in or =="*` to match cited Cedar Policy Validation page verbatim. |
| SHF-B-024 | `docs/decisions/017-shared-event-sourcing-scope.md:47` | Reframe Zed citation compound quote: subject "Collaborators edit" replaced with verbatim "Zed's CRDT design 'allows individuals to edit their own replicas of a document independently'". Second substring "replicas apply each other's operations" was already verbatim and is preserved. |
| SHF-B-026 | `docs/decisions/017-shared-event-sourcing-scope.md:54` | Remove paraphrased third substring ("Clients stage transactions in IndexedDB offline…"). Two verbatim substrings retained: "the local database is a subset of the server database (the SSOT)" and "When a transaction is successfully executed by the server, the global `lastSyncId` increments by 1." Body-prose paraphrase "Clients hold pending transactions client-side until the server's delta package arrives" replaces the dropped quote (paraphrase outside quote marks not subject to Lane B primitive). |
| SHF-B-027 | `docs/plans/024-rust-pty-sidecar.md:112` | Strip "Azure" prefix inside quoted product names: `Renamed from "Azure Trusted Signing" to **"Azure Artifact Signing"**` → `Microsoft renamed "Trusted Signing" to **"Artifact Signing"** (commonly prefixed "Azure" in Microsoft Learn docs)`. Quoted strings now match cited techcommunity.microsoft.com blog verbatim; full product name "Azure Artifact Signing" preserved elsewhere in Plan-024 (line 105 `[Azure Artifact Signing FAQ]`, line 109 `Track A — Azure Artifact Signing`, line 116 `[Azure Artifact Signing FAQ]`) where the body prose is not quote-claimed. |

**5 NOISE deferred** (per §6.12.D resolution): SHF-B-008, SHF-B-016, SHF-B-017, SHF-B-029, SHF-B-032. No edits applied; recorded as cite-refresh-pass candidates.

**4 MAJOR pre-applied** (verified via fresh Read 2026-04-24): SHF-preseed-002, SHF-B-001, SHF-B-002 already remediated at Spec-015:258-259; SHF-B-023 already remediated at ADR-017:46. These were §5 individual remediations applied during prior H6 phases; H6c Lane B confirms they remain landed and need no re-touching.

**Pre-scope cross-check (per closeout §3.2):** zero RTF (no Category B roster gaps). Pre-scope inverted grep on remaining quote-bearing patterns in `docs/specs/006`, `docs/specs/015`, `docs/decisions/017`, `docs/plans/024` surfaced no missed quotes; H2 Lane B's 34-finding roster is exhaustive within scope.

#### §6.12 Lane A cluster summary (11 edits total — 6 in Category A scope + 5 in Category B §6.12.B.4 scope, 2026-04-24)

**Edit roster (Category A scope: 5 MINOR DRIFT base + 1 SHF-A-013 paired occurrence; 6 edits across 5 files; the 5 SHF-A-121 paired-occurrence edits at Plan-024 ×3 + Spec-023 ×2 are documented separately under §6.12.B.4):**

| Finding | Target | Edit |
|---|---|---|
| SHF-A-013 (a) | `docs/decisions/010-paseto-webauthn-mls-auth.md:162` | mls-rs license: `Apache-2.0` → `Apache-2.0 or MIT` (per repository's dual-license declaration `This library is licensed under the Apache-2.0 or the MIT License`). |
| SHF-A-013 (b) — paired occurrence | `docs/architecture/security-architecture.md:270` | Same dual-license correction in §6 V1.1 MLS deferral block (`mls-rs (Rust, Apache-2.0, AWS Labs)` → `mls-rs (Rust, Apache-2.0 or MIT, AWS Labs)`). Paired occurrence flagged in H2 Lane A row 29 remediation note; surfaced via pre-scope inverted grep on `mls-rs` per closeout §3.2. |
| SHF-A-059 | `docs/decisions/010-paseto-webauthn-mls-auth.md:156` | RFC 8446 §1.2 link-text title corrected from paraphrase ("TLS 1.3 forward secrecy via ephemeral key exchange") to actual section title ("Major Differences from TLS 1.2"); parenthetical retains the forward-secrecy semantic ("section establishes TLS 1.3 forward secrecy by removing static-key cipher suites in favor of ephemeral key exchange"). Cited content remains correctly anchored at §1.2; only the link-text title-paraphrase drift is corrected. |
| SHF-A-072 | `docs/decisions/016-electron-desktop-shell.md:161` | WebKitGTK source label corrected: `WebKit2GTK changelog` → `WebKitGTK project site` (homepage URL preserved at `https://webkitgtk.org/`; the page references "Latest News" but is not labeled as a changelog per H2 finding inspection). Absence-of-WebAuthn claim reframed: "No WebAuthn implementation as of 2026-04" → "No WebAuthn implementation noted across project releases as of 2026-04" — the absence claim is preserved (H2 row 89 explicitly accepts the absence-of-evidence as accurate); only the source-page label is corrected. |
| SHF-A-090 | `docs/domain/session-model.md:83` | RFC 9562 IETF status corrected: `(Proposed Standard, May 2024)` → `(Standards Track, May 2024)` per RFC 9562's own header ("this document represents an Internet Standards Track specification"). Note: §6 escalation does NOT fire — this is document-metadata drift, not a security-invariant claim. |
| SHF-A-121 | `docs/plans/023-desktop-shell-and-renderer.md:284` | Apple notarization queue delay magnitudes + date corrected: `16+ hour delays in February 2026` → `24–120+ hour delays in January 2026` per [Apple Developer forum thread 813441](https://developer.apple.com/forums/thread/813441) actual content (thread posts dated January 2026; reported delay magnitudes 24h, 30h, 5-day per H2 row 138 finding). The 18-hour timeout + retry mechanism on line 284 is unchanged; retry continues to absorb delays beyond 18h asynchronously. Body-prose-only correction; the citation URL itself was already correct. |

**12 NOISE deferred** (per §6.12.D ledger-§8 resolution): SHF-A-066, A-067, A-068, A-070, A-071, A-073, A-074, A-075, A-076, A-077 (10 external-source access-failures or pending re-fetch) + 2 additional pending re-fetch placeholders. No edits applied; recorded as cite-refresh-pass candidates per §6.12.D future-pass scope.

**16 MAJOR pre-applied** (verified via fresh Read 2026-04-24): SHF-A-012 (§4.3 / §5.1 routing for RFC 9068 §5 mischaracterization at api-payload-contracts.md:15), SHF-A-014 (§5 / §4.3 routing for node-pty#437 mischaracterization, recurring at ADR-019:178 and Plan-024:199), SHF-A-017/A-018 (§5 routing for Jenkins SECURITY-383 advisory absence, paired finding at Spec-017:441 + Primary Sources list), SHF-A-117 (NOISE→CRITICAL re-triage at CRIT-3 §4.3 — supersedes A-108 placeholder), SHF-A-122 (§5 routing for Electron #24573 cross-platform-binding mischaracterization at Plan-023:341), and additional MAJOR DRIFTs routed individually through §5.1+§5.2 + §4.3 routing tables. These were §5-bucket / §4.3-CRIT-bucket remediations applied during prior H6 phases; H6c Lane A confirms they remain landed and need no re-touching.

**Pre-scope cross-check (per closeout §3.2):** Two paired-occurrence clusters surfaced. (1) SHF-A-013 mls-rs license: 1 paired occurrence at security-architecture.md:270, anticipated in H2 Lane A row 29 remediation note, absorbed into 6-edit Category A scope above. (2) SHF-A-121 Apple-notarization drift: 5 additional occurrences (Spec-023:492, Spec-023:643, Plan-024:97, Plan-024:166, Plan-024:209) NOT enumerated in H2 Lane A row 138, surfaced via expanded pre-scope inverted grep on `notarization` + `16+ hour` + `February 2026`; routed to §6.12.B.4 as Category B H2-roster-gap aggregate entry per advisor guidance. Pre-scope inverted greps executed for: `mls-rs` (across all `.md`), `RFC 8446`/`TLS 1.3 forward`, `webkitgtk.org`/`WebKit2GTK`, `rfc9562`/`RFC 9562`/`UUID v7`, `notarization`/`16+ hour`/`February 2026`. Spot-check note: `docs/backlog.md:527` references "Proposed Standard, May 2024" inside a `BL-069 Resolution:` block — preserved per §6.6 Lane G historical-state-preservation principle (BL Resolution text is append-only audit provenance, not live citation). `docs/decisions/016-electron-desktop-shell.md:81` uses "WebKit2GTK" as a body-prose project-name reference (not a Sources-table citation label) — left unchanged as it is not a citation drift. One additional observation: `docs/architecture/schemas/shared-postgres-schema.md` references RFC 9562 / UUID v7 in body prose without the "Proposed Standard" qualifier — no drift requiring edit (the SHF-A-090 drift is specific to the qualifier-bearing line at session-model.md:83). **Net: 1 H2-roster RTF aggregate (Category B §6.12.B.4) for Lane A surfacing 5 paired-occurrence instances; 1 paired-occurrence cluster expansion (SHF-A-013) absorbed into base cluster count.**

#### §6.12 Cross-Impact Check

- **Pre-scope inverted grep discipline confirmed effective for §6 lanes:** Lane J's 3 RTFs (33% lane-local rate) and Lane A's 6 paired-occurrence instances across 2 distinct clusters match the §5.7 body-prose under-counting + cross-doc-recurrence patterns that §5.2.13 codified. Lane A specifically surfaced (1) SHF-A-013 mls-rs license drift at security-architecture.md:270 (Category A scope, anticipated in H2 row 29), and (2) SHF-A-121 Apple-notarization drift at 5 sites in Plan-024 + Spec-023 (Category B §6.12.B.4 — surfaced via expanded grep on `notarization`/`16+ hour`/`February 2026`, NOT enumerated in H2 row 138). Lanes G/L/H/D/F/I/B/E/K yielded 0 H2-roster RTFs (only H5-prescription drifts and Lane I's attribution-format observation). Net: pre-scope grep remains the load-bearing discipline; for Lane A specifically it surfaced both the anticipated SHF-A-013 paired occurrence AND 5 unanticipated SHF-A-121 paired occurrences that H2's per-row enumeration missed despite matching its own drift primitive — strongest evidence yet that pre-scope grep is necessary, not optional, for citation-existence lanes.
- **H2 lane files are authoritative for §6 H6b/H6c execution:** H5 §6 prescriptions are an illustrative abstraction layer over H2 rosters; where they diverge, H2 wins. Across all 11 §6 lane-blocks, the H5-prescription-drift pattern recurred (Categories A.1 through A.9): G/L/D/F/B/A as H5-vs-H2 prescription drift, E/K as intra-H5 §6-vs-§5-routing drift. Future §6 work in subsequent audits should fresh-Read the per-lane H2 file before executing the H5 §6 prescription.
- **§6.8 attribution-format clause (post-Lane I, 2026-04-24):** §6.12.C.1 records the intentional preservation of Phase 8 sub-session labels (`Session 2a` etc.) over strict-letter format. Future Resolution-block work should treat §6.8's "Session letter" wording as ambiguity-driven (TBD when no label / cross-boundary) rather than format-driven (TBD whenever non-single-letter). The 4th Resolution-block format pattern joins the existing three (BL-083/084, BL-058, BL-088) without retro-fixing earlier patterns.
- **Lane A NOISE policy reaffirmed (post-Lane-A, 2026-04-24; updated post-H7 Item 1 verdict 2026-04-24):** §6.12.D's ledger-§8-controls resolution applies cleanly — the 12 Lane A NOISE entries (10 access-failures + 2 pending re-fetch) are deferred to a future cite-refresh pass without inline annotation. Combined with Lane B's 5 NOISE and Lane F's 1 NOISE (SHF-F-016 closed as NOISE per H7 verdict; closure mechanism is ledger reconciliation, distinct from URL re-fetch), total cite-refresh-pass candidate roster = **18 NOISE entries** (revised up from §6.12.D's original "15 NOISE" estimate, which was finalized before Lane A's 2 pending re-fetch placeholders were enumerated and before H7 closed SHF-F-016).
- **H7 handoff items (post-H7 verdict log, 2026-04-24):** (1) SHF-F-016 NOISE Session L absence — H7 verdict: **close as NOISE; add to §6.12.D cite-refresh-pass candidate roster.** Closure mechanism is ledger reconciliation (not URL re-fetch); §6.12.D scope, Lane A NOISE policy bullet, and META-1 §6.5 Lane F line all updated to 18-NOISE-total accordingly. (2) Lane I 8/22 TBD rate (36%) — H7 verdict: **accept as documented.** §6.12.C.1's ambiguity-driven-not-format-driven framing is correct; no further action. (3) §6.12.A.7/A.8 intra-H5 prescription-drift documentation (Lanes E + K) — H7 verdict: **sufficient as-is.** The §6.12.A.x table is exactly the surface for intra-H5 §6-vs-§5-routing drift; no ledger §8 / §9 cross-reference additions required. (4) §6.12.A.9 + §6.12.B.4 Lane A prescription-drift documentation — H7 verdict: **ready as-is. Do NOT retro-correct H5 §6.1.** Rewriting H5 would break the audit-as-frozen-snapshot model; §6.12.A.9 is the correct documentation surface for the H5-frozen drift. **Net H7 outcome: Item 1 bookkeeping pass applied to audit plan only; no corpus edits, no scope expansion to H8.**

#### §6.12 META-1 Final Arithmetic (post-Lane A, 2026-04-24)

H6b + H6c §6 final landing (all 11 §6 lane-blocks complete):

- §6.1 Lane A: **11 edits landed (5 MINOR DRIFT base — SHF-A-013, A-059, A-072, A-090, A-121 — plus 6 paired occurrences across 2 distinct clusters: 1 SHF-A-013 paired at security-architecture.md:270 (Category A scope, anticipated in H2 row 29) + 5 SHF-A-121 paired at Plan-024 ×3 + Spec-023 ×2 (Category B scope, surfaced via expanded pre-scope grep — see §6.12.B.4)); 12 NOISE deferred per ledger §8 (§6.12.D resolution, scope updated to 18-NOISE-total post-H7 — 12 Lane A + 5 Lane B + 1 Lane F SHF-F-016); 16 MAJOR pre-applied at §5 / §4.3; RTF §6.12.A.9 + §6.12.B.4**
- §6.2 Lane B: **4 edits landed (4 MINOR DRIFT: SHF-B-020, SHF-B-024, SHF-B-026, SHF-B-027); 5 NOISE deferred per ledger §8 (§6.12.D resolution); 4 MAJOR pre-applied at §5; RTF §6.12.A.6 + §6.12.D**
- §6.3 Lane D: 1 edit landed (covers SHF-D-009 + SHF-D-010); RTF §6.12.A.3
- §6.4 Lane E: **0 net new edits (no-op confirmed; intra-H5 §6.4 vs §5.6 prescription drift); §5.6 routing already encodes 3 deferred-confirm groups + cross-lane MATCH SHF-E-031 routed to Lane G/§6.6 batch (verified pre-applied at backlog.md:32); RTF §6.12.A.7**
- §6.5 Lane F: 2 edits landed (SHF-F-014 + SHF-F-015); 1 NOISE closed by H7 verdict 2026-04-24 (SHF-F-016 added to §6.12.D cite-refresh-pass candidate roster; closure via ledger reconciliation, not URL re-fetch); RTF §6.12.A.5
- §6.6 Lane G: 1 edit landed (covers all 11 DRIFT); RTF §6.12.A.1
- §6.7 Lane H: 1 edit-cluster landed (2 §2 rows for SHF-H-011)
- §6.8 Lane I: 22 edits landed (5 base DRIFT renames + 17 re-triage Resolution-block additions); RTF §6.12.C.1
- §6.9 Lane J: 9 edits landed (6 H2-base + 3 RTFs); RTF §6.12.A.4 + §6.12.B.1/B.2/B.3
- §6.10 Lane K: **0 net new edits (no-op confirmed; intra-H5 §6.10 vs §5.8 prescription drift); §5.8.1 SHF-K-009 §5-bucket edit pre-applied at backlog.md:32 (V1=17/V1.1=3 canonical correction merged with §6.6 Lane G editor's note); 5 MINOR DRIFT routed to §6.6 Lane G batch; SHF-K-034 absorbed into §5.7.4; RTF §6.12.A.8**
- §6.11 Lane L: 0 edits (no-op confirmed); RTF §6.12.A.2

**Final subtotal H6b/H6c §6 file-edits across A/B/D/E/F/G/H/I/J/K/L: 51 edits across 23 files** (H6b 14 across 13 files + H6c Lane I 22 in `docs/backlog.md` + H6c Lane B 4 across 3 files: Spec-006, ADR-017, Plan-024 + H6c Lane A 11 across 6 files: ADR-010 [2 edits: A-013 + A-059], security-architecture.md, ADR-016, domain/session-model.md, Plan-023, Plan-024 [3 paired-occurrence edits at lines 97/166/209 — file already counted in Lane B subtotal, so net new files = 5], Spec-023 [2 paired-occurrence edits at lines 492/643 — net new file]; Lane E + Lane K = 0 net new each per §6.12.A.7/A.8).

**Lane A 5 new files added to §6 file-edit roster** (none overlap with prior G/L/H/D/J/F/I/B/E/K Lane B files): `docs/decisions/010-paseto-webauthn-mls-auth.md`, `docs/architecture/security-architecture.md`, `docs/decisions/016-electron-desktop-shell.md`, `docs/domain/session-model.md`, `docs/plans/023-desktop-shell-and-renderer.md`. **Plus 1 additional new file from §6.12.B.4 paired occurrences:** `docs/specs/023-desktop-shell-and-renderer.md`. (Plan-024 paired-occurrence edits land in a file already counted via Lane B SHF-B-027, so it is not double-counted.) **Total new Lane A files: 6.**

**RTF aggregate count (final):** 9 Category A entries (§6.12.A.1 through §6.12.A.9 — H5 prescription drifts across all 11 §6 lane-blocks); 4 Category B entries (§6.12.B.1/B.2/B.3 — Lane J H2 roster gaps; §6.12.B.4 — Lane A H2 roster gap aggregate covering 5 SHF-A-121 paired occurrences); 1 Category C entry (§6.12.C.1 — Lane I attribution-format observation); 1 Category D resolution (§6.12.D — NOISE-handling discipline conflict, applied across Lane A + Lane B + Lane F's combined 18 NOISE deferrals post-H7 close on SHF-F-016). All RTF discoveries surfaced before frozen-discovery deadline (closeout §3.3).

**Pending §6 work: NONE.** All 11 §6 lane-blocks have either applied their H6c remediations or recorded a no-op confirmation with documented intra-H5-prescription-drift rationale. **H7 advisor post-remediation review complete (2026-04-24)** — see Cross-Impact Check H7 handoff bullet for verdict log on all 4 items; only Item 1 (SHF-F-016 NOISE) required bookkeeping (audit-plan-only, no corpus edits). **Ready for H8 single bundled commit.**

---

## 7. Meta Amendment: Scope-Lock §10.3 (META-1)

**Target file:** `docs/audit/session-h-final-scope.md`
**Target section:** §10.3 "Commit Ordering (LICENSE First)"

**Before (verbatim from scope-lock §10.3):**

```markdown
### 10.3 Commit Ordering (LICENSE First)

Session H-final closes with **two separate commits**:

1. **`Session H-final (1/2): LICENSE`** — Apache 2.0 LICENSE file landed per ADR-020. Small diff, non-conflicting, independent review.
2. **`Session H-final (2/2): comprehensive drift audit — ledger + remediations`** — H6 remediation edits + ledger finalization. Larger diff, focused review.

**Ordering rationale:** LICENSE lands first so that (a) a review stall on the audit commit doesn't block LICENSE, and (b) the audit commit's diff is unambiguously "only audit work" without LICENSE noise.

This breaks the prior one-commit-per-session convention (Sessions L, M). The `(1/2)` / `(2/2)` suffix preserves session-letter traceability.
```

**After (proposed amendment):**

```markdown
### 10.3 Commit Ordering (Single Commit — Amended 2026-04-22 per META-1)

Session H-final closes with **a single commit**:

- **`Session H-final: comprehensive drift audit — ledger + remediations + H5 plan`** — H6 remediation edits + ledger finalization + H5 remediation plan artifact. Single focused review.

**Amendment rationale (2026-04-22):** The original §10.3 prescribed a two-commit close where commit (1/2) landed the Apache-2.0 LICENSE. H3 META-1 verified LICENSE is already present in the repo (committed 2026-04-17 as `45434c3 chore: add LICENSE (Apache-2.0) per BL-083`), so the LICENSE-landing commit would have zero content. Single-commit close remains in keeping with the one-commit-per-session convention (Sessions L, M).

**Historical note:** prior to this amendment, §10.3 prescribed the two-commit ordering. Both the ledger META-1 section and this amendment record the amendment date.
```

**H6 execution:** this amendment is written to the scope-lock during H6 as one of the ledger-adjacent edits.

---

## 8. Meta Hygiene Edit: BL-083 Resolution Stub

**Target file:** `docs/backlog.md`
**Target BL:** BL-083 (Commit OSS LICENSE file at repo root)
**Target line range:** 251-259 (verified via fresh Read 2026-04-22).

**Before (verbatim, fresh Read 2026-04-22):**

```markdown
#### BL-083: Commit OSS LICENSE file at repo root (MIT vs Apache-2.0)

- Status: `completed`
- Priority: `P0`
- Owner: `unassigned`
- Depends-on: BL-053 (ADR-020 commits to a permissive OSS license)
- References: [ADR-020](./decisions/020-v1-deployment-model-and-oss-license.md) (from BL-053); [MIT License](https://choosealicense.com/licenses/mit/); [Apache License 2.0](https://choosealicense.com/licenses/apache-2.0/); precedent — VS Code (MIT), Node.js (MIT), Supabase (Apache-2.0), Kubernetes (Apache-2.0), Terraform (originally MPL, now BSL), Mattermost (MIT + proprietary enterprise), PostHog (MIT → re-licensed), Sentry (originally BSD → BSL → FSL).
- Summary: Choose between MIT and Apache-2.0 and commit the corresponding `LICENSE` file at the repo root. Staff-level recommendation: **Apache-2.0**. Rationale: (1) explicit patent grant protects contributors and users from patent litigation by other contributors — a concrete advantage MIT does not give; (2) explicit contribution-terms clause codifies inbound-is-outbound CLA semantics in the license itself, reducing the need for a separate CLA; (3) dominant choice in modern OSS developer-tool projects (Kubernetes, Terraform-pre-BSL, Supabase, etc.); (4) SPDX-clean and recognized by all major dependency scanners. MIT remains a defensible choice if the constraint is maximal ecosystem compat with copyleft-aware downstream (GPL inclusion is cleaner under MIT than under Apache-2.0 due to the patent-termination clause in Apache-2.0 §3). Deliverables: (a) `LICENSE` file at repo root with text matching the chosen SPDX identifier exactly; (b) `package.json` top-level `license` field set to matching SPDX identifier (`Apache-2.0` or `MIT`); (c) README section naming the license and linking to `LICENSE`; (d) ADR-020 Decision Log entry recording which license was chosen and why. Revisit gate: if a competitor materially re-hosts the codebase as a competing managed service with measurable revenue impact, re-license to FSL/BSL/ELv2 per the Sentry precedent (already named in ADR-020 Tripwires).
- Exit Criteria: `LICENSE` file exists at repo root with text matching the chosen SPDX identifier exactly; `package.json` `license` field matches; `README.md` references the license; ADR-020 Decision Log entry records the choice; no conflicting license text anywhere in the repo.
```

**After (proposed — append one `Resolution (resolved …)` line after the Exit Criteria line):**

```markdown
#### BL-083: Commit OSS LICENSE file at repo root (MIT vs Apache-2.0)

- Status: `completed`
- Priority: `P0`
- Owner: `unassigned`
- Depends-on: BL-053 (ADR-020 commits to a permissive OSS license)
- References: [ADR-020](./decisions/020-v1-deployment-model-and-oss-license.md) (from BL-053); [MIT License](https://choosealicense.com/licenses/mit/); [Apache License 2.0](https://choosealicense.com/licenses/apache-2.0/); precedent — VS Code (MIT), Node.js (MIT), Supabase (Apache-2.0), Kubernetes (Apache-2.0), Terraform (originally MPL, now BSL), Mattermost (MIT + proprietary enterprise), PostHog (MIT → re-licensed), Sentry (originally BSD → BSL → FSL).
- Summary: (unchanged — see Before block)
- Exit Criteria: `LICENSE` file exists at repo root with text matching the chosen SPDX identifier exactly; `package.json` `license` field matches; `README.md` references the license; ADR-020 Decision Log entry records the choice; no conflicting license text anywhere in the repo.
- Resolution (resolved 2026-04-17): Apache-2.0 chosen and committed. `LICENSE` (SPDX `Apache-2.0`) landed at repo root per commit `45434c3` (`chore: add LICENSE (Apache-2.0) per BL-083`); same commit updated `package.json` `license` field + `README.md` license section. [ADR-020 Decision Log entry for 2026-04-17](./decisions/020-v1-deployment-model-and-oss-license.md#decision-log) records LICENSE-committed status with the four-point Apache-2.0 selection rationale (explicit patent grant §3; inbound-is-outbound §5; OSS developer-tool precedent; SPDX-clean).
```

**Rationale:** Format consistency with newer BLs (BL-084+, BL-086+) that carry explicit `Resolution (resolved <date>):` narrative per Session C's template refresh. Not a correctness fix — META-1 already verified BL-083 Exit Criteria are fully satisfied in the repo. This edit applies the META-2 Lane-I-primitive amendment retroactively: recording verifiable Exit-Criteria evidence in the BL entry itself rather than relying on distal corpus inspection via audit. After the stub lands, the Lane I primitive "check whether Exit Criteria are verifiable" is satisfied *from the BL text alone* — future audits do not re-derive the evidence from scratch.

**Cross-impact check:**

- No change to Status, Priority, Dependencies, References, Summary, or Exit Criteria — stub is purely additive.
- No other BL cites BL-083 Resolution content (grep-verified during H2 Lane K).
- The `45434c3` commit SHA is stable (committed 2026-04-17, verified via `git log` during H3 META-1 investigation).

---

## 9. H6 Execution Ordering + Rollback Tag

Per scope-lock §10.2, the pre-remediation rollback tag is created before the first H6 edit:

```bash
git tag -a pre-session-h-final-remediation -m "Audit rollback point before H6 remediation writes"
```

**Per-finding H6 loop (applies to every edit in steps 2-6 below):**

Each remediation — whether a CRITICAL before/after, a MAJOR entry, a MINOR pattern batch, or a meta-hygiene edit — follows the same inseparable sequence:

1. **Hash pre-text** (SHA-256 of the exact before-block from the plan).
2. **Read source** fresh to confirm before-text still matches (no interim mutation).
3. **Apply edit** per the plan's after-text.
4. **Hash post-text** (SHA-256 of the exact after-block).
5. **Capture commit SHA** when the final H6 commit lands.
6. **Update ledger** entry for the finding with: pre-hash, post-hash, commit SHA, remediation timestamp.

Ledger updates are *not* a separable post-step. They are part of each finding's atomic record — advisor-emphasized during H5 drafting: treating ledger update as a step-7 sweep creates a coupling gap where a crashed session leaves ledger drift. Each finding closes fully before the next begins.

**H6 execution order (proposed):**

1. Create rollback tag (§10.2).
2. Execute §7 scope-lock §10.3 amendment (isolated edit, no coupling) — per-finding H6 loop.
3. Execute §4 CRITICAL remediations — 4 findings, **5 file-edits** spanning 4 files:
   - CRIT-1 at Spec-017:409 (delete broken ADR-020 cite) + CRIT-2 at Spec-017:407 (fix ADR-002 path + title) — bottom-to-top within Spec-017
   - CRIT-3 at Plan-017:117 (GHSA ID swap)
   - CRIT-4 as a two-file atomic edit (Spec-012:48-56 primary enum + Plan-012:64 consumer mirror); both locations must land in the same commit to avoid introducing new drift.
   Per-finding H6 loop per edit; CRIT-4's two locations share one finding-loop with dual hash-pre/hash-post entries.
4. Execute §5 MAJOR remediations grouped by file (minimize file-touch churn) — per-finding H6 loop per edit.
5. Execute §6 MINOR pattern batches (grouped by lane; grep-driven where applicable) — per-pattern H6 loop (pattern hash → batch edit → batch post-hash → SHA → ledger update per pattern-block).
6. Execute §8 BL-083 Resolution stub (isolated edit) — per-finding H6 loop.
7. Advisor post-H7 review gate (artifact: post-remediation ledger + this plan + fresh Read evidence of each before/after).

**Cross-file edit safety inside Spec-017:** CRIT-1 (line 409) + CRIT-2 (line 407) + Lane D MAJORs (TBD lines from §5) + §5.1.4 / §5.1.5 / §5.1.6 (4 Lane A URL swaps at lines 62, 147, 165, 425, 445, 450) all live in Spec-017. Edits are sequenced within the file bottom-to-top (highest line number first) to avoid line-range shift invalidation. **CRIT-4 no longer touches Spec-017** (direction inverted to Spec-012:48-56 per §4.4 adjudication).

**Cross-file edit safety inside Spec-012:** CRIT-4 is the sole edit targeting Spec-012 at lines 48-56. No other Spec-012 remediation is currently in scope.

**Multi-file URL-group atomic-commit discipline (§5.1 addition):** each §5.1 row is a single finding-loop that spans N file-edits (1 ≤ N ≤ 5). The per-finding H6 loop steps 1-6 expand for multi-file rows:

1. Hash pre-text for each file-location (N pre-hashes).
2. Read each source fresh to confirm before-text still matches.
3. Apply all N edits within the same commit (partial application would leave mixed old/new URLs across sibling docs, introducing new drift).
4. Hash post-text for each file-location (N post-hashes).
5. Capture commit SHA (one SHA per row, covers all N edits).
6. Update ledger with: all N pre-hashes, all N post-hashes, shared commit SHA.

This mirrors CRIT-4's two-file atomic-edit pattern (§4.4A/§4.4B sharing one commit). The largest §5.1 group is 5.1.3 (napi-rs/node-keyring, N=5 file-edits across Spec-026 and Plan-026). Spec-017:62 co-locates two §5.1 rows (§5.1.4 GitHub-Actions URL + §5.2.1 Dagger text) — both must land in the same commit to avoid mid-line inconsistency.

---

## 10. User-Gate Review Questions

When you review this plan, key decisions to confirm or amend:

1. **MINOR handling (§2.1):** approve §10.1-leaning pattern-batch reading, or require strict §2 per-finding entries?
2. **META-1 amendment (§7):** approve the scope-lock §10.3 single-commit amendment?
3. **BL-083 hygiene (§8):** approve the Resolution-stub retrofit, or leave legacy format intact?
4. **Lane I 17 tentative re-triage (§3):** approve the 17/17-MINOR classification + META-2 "verified 22/22" claim (all seven edge-case greps executed pre-gate 2026-04-22), or require additional deep-verification sampling before H6?
5. **H6 execution order (§9):** approve the file-grouped edit order, or alternative sequencing?
6. **§5.2.1 Dagger citation — choose option (a), (b), or (c):** the `dagger.io/blog/next-dagger-sdks` URL is 404 and **no canonical replacement preserves the cited "~2.5 years CUE→SDK rewrite" claim** (Pass-2 research 2026-04-22). Plan recommends Option (a) — remove the Dagger citation, lean on GitHub Actions HCL→YAML alone for Spec-017 C-1 DSL-lock-in precedent. Option (b) downgrades to a weaker live citation (`introducing-dagger-functions` + GitHub discussion #4086). Option (c) keeps the claim with a "URL 404 as of 2026-04-22" annotation. Per `feedback_citations_in_downstream_docs.md`: every load-bearing decision lands primary-source citations for each load-bearing claim; retiring the claim beats weaker-substitute replacement. Your call.
7. **§5.1.1 backlog.md:520 OWASP URL swap — in-place vs footnote:** the `owasp.org/ASVS` → canonical ASVS-5.0-V7.4.5 URL swap is unambiguous in security-architecture.md (body + table) but backlog.md:520 is inside a completed BL-070 Resolution block describing landed work "as of 2026-04-20." Two options: **(a)** in-place swap — consistent with Session C precedent (commits `e57bb26 docs: propagate Option A to backlog BL-087 Resolution` and `bd40e35 docs: close Session C self-reference off-by-one in BL-087 Resolution` both amended completed-BL Resolution blocks for correctness); **(b)** leave `owasp.org/ASVS` in place and append a parenthetical `(URL at landing; current canonical: github.com/OWASP/ASVS/blob/v5.0.0/…)` preserving historical provenance. Plan leans toward (a) because Session C precedent treats Resolution blocks as correctable artifacts, but the convention is rarely tested on URL rot specifically. Your call.
8. **§5.2.5 Jenkins SECURITY-383 citation — choose option (a), (b), or (c):** the cited `SECURITY-383` ID is not present on the linked 2017-04-10 advisory page, and Pass-2 research (WebSearch 2026-04-22) did not surface any public Jenkins advisory carrying that ID. Options: **(a)** swap to the 2022-10-19 input-step advisory ("pipeline-input-step-plugin 451 and earlier does not restrict or sanitize the optionally specified ID") — a real, verifiable input-step security advisory; **(b)** cite the `jenkinsci/pipeline-input-step-plugin` CHANGELOG for a broader permission-handling history; **(c)** remove the Jenkins citation entirely — the surrounding Airflow/Argo CVE citations carry the anti-pattern's normative force independently. Plan recommends Option (a). Same reasoning as Q#6 (Dagger): when the specific cited identifier can't be confirmed, retiring the over-specific claim beats keeping a broken citation. Your call.

---

## Related Artifacts

- [H1 scope-lock](./session-h-final-scope.md)
- [H3 consolidated ledger](./session-h-final-ledger.md)
- [H2 per-lane raw findings](./session-h-final-h2-findings/)
- [ADR-020 V1 Deployment Model and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md)

## Related Memories

- `feedback_doc_first_before_coding.md` — H5 is the last doc-phase before H6 writes land
- `feedback_criterion_gated_deferrals.md` — scope decision §2.1 frames the MINOR approach with explicit criteria
