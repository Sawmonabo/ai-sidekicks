# Lane C — Internal Cross-Reference Validity (H2 findings)

**Lane:** C
**Verification primitive (verbatim per scope §5):** For each `./...` or `../...` markdown link: resolve relative path from source file; check target file exists. For anchors, check the anchor exists in the target file.
**Verdict scope:** All intra-repo markdown links.
**Output file:** this doc.
**Subagent role:** H2 Lane C audit (PRIMARY on SHF-preseed-003).

---

## Audit Methodology

1. Collected all in-scope `.md` files per scope §3 (119 files across `docs/architecture/`, `docs/decisions/`, `docs/specs/`, `docs/plans/`, `docs/domain/`, `docs/operations/`, `docs/backlog.md`, `README.md`, `docs/vision.md`; `docs/cross-cutting/` absent).
2. For each file: stripped fenced code blocks (```...```/~~~...~~~) and inline code spans (`` `...` ``) to exclude literal-text occurrences from link detection (markdown links inside code spans do not render as links).
3. Extracted markdown links matching `\[([^\]]*)\]\((\.\.?\/[^)\s]+?\.(md|html|sql|json|yml|yaml|ts|js|png|svg))(#[^)\s]+)?(?:\s+"[^"]*")?\)` with per-line line-number capture.
4. Extracted in-file anchor-only links matching `\[([^\]]*)\]\((#[^)\s]+)\)`.
5. Resolved each relative path against the source file's parent directory; checked target existence.
6. For markdown links with anchors: extracted all GitHub-flavored slugs from the target file's `^#{1,6}` headings (no-collapse rule: em-dashes and consecutive whitespace preserve `--` runs) and checked whether the link's anchor matches at least one slug.
7. Assigned verdicts: **MATCH** (file + anchor exist), **DRIFT** (file exists but anchor missing), **ORPHAN** (target missing), **NOISE** (ambiguous).
8. Applied severity rubric per scope §6 inline.
9. Respected scope §4 / §9.3: file-existence checked for links INTO `docs/research/`; anchors inside research files NOT audited.

### Coverage numbers

- **In-scope files audited:** 119
- **Total markdown links extracted (post code-span stripping):** 2,104
- **Verdict breakdown:** 2,099 MATCH · 3 DRIFT · 2 ORPHAN · 0 MISSING · 0 NOISE
- **Non-MATCH findings (entered into ledger):** 5 H2-discovered + 1 pre-seed = **6 total**

Per scope §8.1 verbatim rule: every `claim-text` below is the exact markdown link substring from the source file. `evidence-quote` is `N/A` for this existence-only lane per scope §8.1.

---

## Findings Table

| finding-id | lane | finding-source | doc-path | line-range | claim-text | cited-source | evidence-quote | verdict | severity | severity-ambiguous | severity-rationale | verdict-rationale | remediation-status | remediation-plan-ref | remediation-commit-sha | pre-text-hash | post-text-hash | pre-seeded | pre-seed-outcome | escalated-bl-ref | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SHF-C-001 | C | h2 | docs/architecture/schemas/shared-postgres-schema.md | 177-177 | `[security-architecture.md §Token revocation](../security-architecture.md#token-revocation)` | docs/architecture/security-architecture.md | N/A | DRIFT | MAJOR | false | Anchor drift in a normative schema-retention context that cites a security architecture invariant; the §Decision context will be load-bearing for Plan-010/Plan-018 implementation. Does not rise to CRITICAL because the file exists and the referenced concept is present (Bulk Revoke All For Participant §), but reader cannot jump to the cited section. | Target file `docs/architecture/security-architecture.md` exists but no heading slugifies to `token-revocation`; heading list includes `Bulk Revoke All For Participant (BL-070)` (slug `bulk-revoke-all-for-participant-bl-070`) at L155 and `Daemon Master Key Rotation` at L272 but no `Token revocation` section heading. | found | null | null | null | null | false | null | null | Single-anchor drift. Likely candidate remediation: replace with `#bulk-revoke-all-for-participant-bl-070` or add a `### Token revocation` heading. |
| SHF-C-002 | C | h2 | docs/plans/001-shared-session-core.md | 69-69 | `[Plan-018](./018-identity-provider-adapters.md)` | docs/plans/018-identity-provider-adapters.md | N/A | ORPHAN | MAJOR | false | Broken link inside a normative §Data And Storage Changes table (participants anchor row) that hands off schema ownership to Plan-018. Not CRITICAL because Plan-018's semantic target exists at the correct slot number; this is a file-rename miss, not a missing plan. | Target file `docs/plans/018-identity-provider-adapters.md` does not exist. Plan-018's canonical path is `docs/plans/018-identity-and-participant-state.md` (verified by Glob on `docs/plans/018*`). | found | null | null | null | null | false | null | null | File-rename miss. Candidate remediation: `./018-identity-and-participant-state.md`. |
| SHF-C-003 | C | h2 | docs/specs/017-workflow-authoring-and-execution.md | 407-407 | `[ADR-002 — Local-first architecture](../decisions/002-local-first-architecture.md)` | docs/decisions/002-local-first-architecture.md | N/A | ORPHAN | MAJOR | false | Broken link in the §Governing docs list of a Session M full-rewrite spec (citation density flagged "Very high" in scope §9.1). ADR-002 is governance-normative — Plan-017 readers will hit this. Not CRITICAL because ADR-002 exists at a different filename with adjacent title. | Target file `docs/decisions/002-local-first-architecture.md` does not exist. ADR-002's canonical filename is `docs/decisions/002-local-execution-shared-control-plane.md` (verified by Glob on `docs/decisions/002*`). | found | null | null | null | null | false | null | null | Session M citation-cluster drift (see notes on SHF-C-004/005). Candidate remediation: `../decisions/002-local-execution-shared-control-plane.md`. |
| SHF-C-004 | C | h2 | docs/specs/017-workflow-authoring-and-execution.md | 409-409 | `[ADR-020 — Agent capabilities and contract-ordering](../decisions/020-agent-capabilities-and-contract-ordering.md)` | docs/decisions/020-agent-capabilities-and-contract-ordering.md | N/A | ORPHAN | MAJOR | false | Broken link in §Governing docs of the Session M full-rewrite spec. The cited title ("Agent capabilities and contract-ordering") does NOT match any existing ADR title — this may be a placeholder citation or a conceptual-not-yet-drafted reference; H3 triage should determine intent. Not CRITICAL because Spec-017 does not rely normatively on the specific ADR-020 subject (other citations in the spec cite ADR-015 / ADR-018 for the actual governing constraints). | Target file `docs/decisions/020-agent-capabilities-and-contract-ordering.md` does not exist. The ADR at slot 020 is `020-v1-deployment-model-and-oss-license.md` (V1 Deployment Model and OSS License) — unrelated subject. No ADR titled "Agent capabilities and contract-ordering" exists in the corpus. | found | null | null | null | null | false | null | null | Session M citation-cluster drift. Candidate remediation: delete citation OR clarify the intended ADR (possibly ADR-005 provider-drivers-normalized-interface?). H3 should decide — semantic intent unclear. |
| SHF-C-005 | C | h2 | docs/specs/017-workflow-authoring-and-execution.md | 416-416 | `[Spec-013 — Session timeline](../specs/013-session-timeline-and-presence.md)` | docs/specs/013-session-timeline-and-presence.md | N/A | ORPHAN | MAJOR | false | Broken link in §Related specs of the Session M full-rewrite spec. Semantic target (timeline surfacing for phases) exists at the correct spec number; this is a file-rename miss. Not CRITICAL. | Target file `docs/specs/013-session-timeline-and-presence.md` does not exist. Spec-013's canonical path is `docs/specs/013-live-timeline-visibility-and-reasoning-surfaces.md`. | found | null | null | null | null | false | null | null | Session M citation-cluster drift. Candidate remediation: `../specs/013-live-timeline-visibility-and-reasoning-surfaces.md`. |
| SHF-preseed-003 | C | h2 | docs/architecture/cross-plan-dependencies.md | 82-115 | `- **spec-declared**: the corresponding spec explicitly lists the other spec in its Depends On field\n- **implementation-derived**: the plans share tables, package paths, or cross-cutting concerns that create a build-order dependency not captured in spec Depends On` (legend) AND rows at L98 (Plan-011), L110 (Plan-021), L111 (Plan-022), L112 (Plan-023), L114 (Plan-025), L115 (Plan-026) using `declared in plan header` as the `Type` column value | docs/architecture/cross-plan-dependencies.md (self-referential — structural consistency check) | N/A | DRIFT | MAJOR | true | Legend-label drift in a normative §3 dependency graph. The `declared in plan header` label is a third type not defined in the lines 83-84 legend. Readers must guess its semantic (implicitly: "declared in the target plan's header Dependencies row, not (yet) in its spec's Depends On field"). Severity-ambiguous=true because Session M (BL-097 §7(c)) explicitly triaged this as non-blocking; defaulting to MAJOR per scope §6 ambiguous-severity policy. Does not reach CRITICAL because the plans' actual dependency content is correct — the drift is a taxonomy-legend coverage gap, not a false dependency claim. | **Legend (L83-84) verified to define exactly 2 types: `spec-declared` and `implementation-derived`.** **6 plan rows verified to use `declared in plan header` as the Type column value:** L98 `Plan-011 ... declared in plan header`; L110 `Plan-021 ... declared in plan header`; L111 `Plan-022 ... declared in plan header`; L112 `Plan-023 ... declared in plan header`; L114 `Plan-025 ... declared in plan header`; L115 `Plan-026 ... declared in plan header`. Drift is as-claimed in BL-097 Resolution §7(c); drift has NOT been silently fixed. | deferred | null | null | null | null | true | confirmed-deferred | null | Pre-seeded per scope §9.2 row SHF-preseed-003. BL-097 Resolution §7(c) non-blocking deferral; legend-expansion vs. row-type-rewrite is a choice for Session H-final remediation. No new BL needed unless H3 disagrees with the non-blocking classification. |

---

## Severity Distribution

- **CRITICAL:** 0
- **MAJOR:** 6 (SHF-C-001 · SHF-C-002 · SHF-C-003 · SHF-C-004 · SHF-C-005 · SHF-preseed-003)
- **MINOR:** 0

No findings warranted CRITICAL per scope §6. Rationale: every ORPHAN in this lane has a valid semantic target at the correct slot number (file-rename drift or subject-placeholder), and the single DRIFT (SHF-C-001) points to an existing file whose content covers the cited concept under a different heading. The pre-seed SHF-preseed-003 is marked `severity-ambiguous: true` per scope §6 default-to-MAJOR policy.

---

## Session M Citation-Cluster Signal

3 of 5 H2 ORPHANs (SHF-C-003, SHF-C-004, SHF-C-005) cluster in `docs/specs/017-workflow-authoring-and-execution.md` §Governing docs + §Related specs (lines 406-418). This doc is flagged in scope §9.1 as "Very high" citation density (Session M full rewrite). H3 triage should cross-check against Lane B and Lane D findings on the same doc — the cluster suggests the Session M pass did not execute a filename-resolution sweep over the new citation surface before landing.

---

## Out-of-Scope Confirmations

- Links into `docs/research/*.md` (e.g., `[Pass F — Event taxonomy...](../research/bl-097-workflow-scope/pass-f-event-taxonomy.md)` in Spec-017 L400): **target file existence checked per §4/§9.3; anchors inside research files NOT audited.** All such file-existence checks passed.
- Absolute paths (`/docs/...`) and bare-name paths: **out of primitive scope** (primitive limited to `./` / `../` relative paths). None detected in the corpus anyway.
- Mock HTML references (`assets/hero/*.html`): **out of primitive scope for Lane C** (per scope §3, these are audited only for existence, not content; Lane A/E own this). No `./assets/hero/*.html` relative links detected from in-scope files anyway.
- Non-md relative links with extensions outside the whitelist (`.txt`/`.toml`/`.rs`/`.py`/`.pdf`/`.sh`/`.bash`/`.css`/`.scss`/`.mjs`/`.cjs`): verified absent via companion grep.

---

## Summary Return Manifest (Step 4)

- **Output file path:** `/home/sabossedgh/dev/ai-sidekicks/docs/audit/session-h-final-h2-findings/lane-c-internal-cross-reference-validity.md`
- **Total findings count:** 6 (5 H2-discovered + 1 pre-seeded)
- **Verdict breakdown:** 3 DRIFT · 2 ORPHAN · 0 MISSING · 0 NOISE (2,099 MATCH not ledgered per §7 mapping)
- **Severity:** 6 MAJOR, 0 CRITICAL, 0 MINOR
- **Pre-seed outcome:** SHF-preseed-003 → `confirmed-deferred` (drift exists as claimed; non-blocking deferral holds; `remediation-status: deferred`)
- **Blockers:** none. Ambiguity on SHF-C-004 flagged for H3 triage (broken ADR-020 citation whose subject line does not match any existing ADR in the corpus).
