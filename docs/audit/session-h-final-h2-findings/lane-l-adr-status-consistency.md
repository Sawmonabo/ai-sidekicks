# Lane L — ADR Status Consistency

- **Lane:** L — ADR status consistency
- **Authored:** 2026-04-22
- **Subagent:** general-purpose (Lane L subagent)
- **Verification primitive:** For each ADR: parse header status field; check Amendment History + Decision Log entries align; check downstream docs cite correct status.
- **Verdict scope:** ADR lifecycle status (active/superseded/amended) and amendment chains.

## Audit scope note

In-scope corpus per §3: `docs/architecture/`, `docs/decisions/`, `docs/specs/`, `docs/plans/`, `docs/domain/`, `docs/operations/`, `docs/backlog.md`, `README.md`. Out of scope: `docs/research/`, `docs/reference/`, `docs/archive/`, `docs/vision.md` (not in §3 list), `.claude/`, `tmp/`.

Enhanced scrutiny per §9.1 applied to ADR-015 (§Amendment History + §Decision Log + §V1.1 Criterion-Gated Commitments added in Session M; 17-count amendment).

## ADR inventory

Twenty-two files in `docs/decisions/`:

- `000-adr-template.md` — template, not a decision.
- `001`–`021` — 21 decisions.
- `013-reserved.md` — sole non-`accepted` status: `reserved-skipped` (declared explicitly reserved, no amendment history expected).

All 20 non-template, non-reserved ADRs carry `Status: accepted`. ADR-015 is the only ADR with both an `Amended: 2026-04-22` header field and an `## Amendment History` section. No ADR carries `superseded` or `deprecated` status. No amendment chains to walk.

## Status-field parse

| ADR | Header Status | Header Amended | Amendment History § | Decision Log terminal row |
| --- | --- | --- | --- | --- |
| 001 | accepted | (none) | absent | 2026-04-15 Accepted |
| 002 | accepted | (none) | absent | 2026-04-15 Accepted |
| 003 | accepted | (none) | absent | 2026-04-15 Accepted |
| 004 | accepted | (none) | absent | 2026-04-15 Accepted |
| 005 | accepted | (none) | absent | 2026-04-15 Accepted |
| 006 | accepted | (none) | absent | 2026-04-15 Accepted |
| 007 | accepted | (none) | absent | 2026-04-15 Accepted |
| 008 | accepted | (none) | absent | 2026-04-15 Accepted |
| 009 | accepted | (none) | absent | 2026-04-15 Accepted |
| 010 | accepted | (none) | absent | 2026-04-17 Accepted (post-amendment terminal row; amendments inlined in prose) |
| 011 | accepted | (none) | absent | 2026-04-15 Accepted |
| 012 | accepted | (none) | absent | 2026-04-15 Accepted |
| 013 | reserved-skipped | N/A | N/A | N/A (sentinel file) |
| 014 | accepted | (none) | absent | 2026-04-15 Accepted |
| 015 | accepted | 2026-04-22 | present (Session M) | 2026-04-22 Amended (workflow V1.1→V1; 16→17) |
| 016 | accepted | (none) | absent | 2026-04-16 Accepted |
| 017 | accepted | (none) | absent | 2026-04-17 Accepted |
| 018 | accepted | (none) | absent | 2026-04-17 Accepted |
| 019 | accepted | (none) | absent | 2026-04-17 Accepted |
| 020 | accepted | (none) | absent | 2026-04-17 Accepted |
| 021 | accepted | (none) | absent | 2026-04-17 Accepted |

Internal alignment: for every ADR, header Status matches the Decision Log's terminal row's resulting status. ADR-015's triple-alignment (header Amended + §Amendment History + Decision Log row) is the only non-trivial amendment state; all three surfaces agree on date (2026-04-22), driver (BL-097), and content (workflow V1.1→V1; count 16→17).

## Verdict breakdown

- MATCH: 21 ADRs (all `accepted` ADRs + ADR-013 `reserved-skipped`; internal status alignment preserved in every case)
- DRIFT: 0
- ORPHAN: 2 (Spec-017 lines 407, 409 — ADR-NNN paths that do not exist; cross-lane C overlap flagged for H3)
- MISSING: 0
- NOISE: 0
- Pre-seeded: 1 (SHF-preseed-001)

Total drift/orphan findings enumerated below: 2 CRITICAL + 1 pre-seeded row = 3 rows. All non-enumerated 21 ADRs are MATCH (summarized in table above rather than per-row to keep the ledger concise per §7 schema intent — H3 may expand if MATCH rows are required).

## Findings

| finding-id | lane | finding-source | doc-path | line-range | claim-text | cited-source | evidence-quote | verdict | severity | severity-ambiguous | severity-rationale | verdict-rationale | remediation-status | pre-seeded | pre-seed-outcome | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SHF-preseed-001 | L | preseed | docs/specs/017-workflow-authoring-and-execution.md | 42-42 | `SQLite STRICT tables adoption (criterion-gated V1.x deferral per Wave 2 §4.1 — cross-plan policy change; Plan-017 schema uses repo's existing TEXT-column convention).` | BL-097 Resolution §7(a) | `SQLite STRICT tables adoption (criterion-gated V1.x deferral per Wave 2 §4.1 — cross-plan policy change; Plan-017 schema uses repo's existing TEXT-column convention).` | MATCH | MINOR | false | Pre-seed scope: verify whether a SQLite STRICT cross-cutting ADR has been drafted; confirm deferral state otherwise. Grep over `docs/decisions/` for `STRICT` returned zero hits — no STRICT ADR has been drafted. Spec-017:42 + Spec-017:377 (`If cross-plan SQLite STRICT adoption warrants, draft the SQLite STRICT policy ADR (proposed follow-up task per Wave 2 §4.1).`) both name the deferral with primary-source citation. No V1 feature has become load-bearing on STRICT. | STRICT ADR absence is consistent with the V1.x criterion-gated deferral per BL-097 Resolution §7(a) and Spec-017:42/:377; no drift. | deferred | true | confirmed-deferred | SHF-preseed-001 outcome per §9.2. Plan-017 schema at `docs/architecture/schemas/local-sqlite-schema.md` also contains zero `STRICT` references (verified via grep). ADR-004 (SQLite) does not commit to STRICT. Deferral rationale holds. |
| SHF-L-001 | L | h2 | docs/specs/017-workflow-authoring-and-execution.md | 407-407 | `- [ADR-002 — Local-first architecture](../decisions/002-local-first-architecture.md)` | docs/decisions/002-local-execution-shared-control-plane.md (actual file title: `Local Execution Shared Control Plane`) | `- [ADR-002 — Local-first architecture](../decisions/002-local-first-architecture.md)` | ORPHAN | CRITICAL | false | §6(b): "Doc references a normative spec that does not exist." Spec-017 is a Session M full rewrite (§9.1 Very High citation density); the Governing-docs section is a load-bearing pointer surface for Plan-017 implementers. Path `../decisions/002-local-first-architecture.md` resolves to a non-existent file; ADR-002's actual path is `002-local-execution-shared-control-plane.md` with title "Local Execution Shared Control Plane." Two defects: (1) broken relative path, (2) wrong ADR title. Lane L framing: the cited ADR status (implicit `accepted`) cannot be verified against a non-existent file. | ORPHAN verdict over DRIFT because the cited artifact at the stated path does not exist; Lane L cannot parse a status field that isn't there. | found | false | null | cross-lane-c (broken path) — H3 should adjudicate whether this is more defensibly logged as Lane C (cross-reference validity) or Lane L (ADR status consistency); logged here for Lane-L-scope orthogonality per §8 invariant. |
| SHF-L-002 | L | h2 | docs/specs/017-workflow-authoring-and-execution.md | 409-409 | `- [ADR-020 — Agent capabilities and contract-ordering](../decisions/020-agent-capabilities-and-contract-ordering.md)` | docs/decisions/020-v1-deployment-model-and-oss-license.md (actual file title: `V1 Deployment Model (OSS Self-Host + Hosted SaaS) and OSS License`) | `- [ADR-020 — Agent capabilities and contract-ordering](../decisions/020-agent-capabilities-and-contract-ordering.md)` | ORPHAN | CRITICAL | false | §6(b): "Doc references a normative spec that does not exist." Path `../decisions/020-agent-capabilities-and-contract-ordering.md` resolves to a non-existent file. Actual ADR-020 is `020-v1-deployment-model-and-oss-license.md` titled "V1 Deployment Model (OSS Self-Host + Hosted SaaS) and OSS License" — a completely different subject matter from "Agent capabilities and contract-ordering." This suggests either (a) a renamed/superseded ADR plan was cited, or (b) the pointer was intended for a future ADR. Lane L framing: the cited ADR status cannot be verified against a non-existent file; the actual ADR-020 governs deployment/license, not agent capabilities. | ORPHAN verdict over DRIFT because the cited artifact at the stated path does not exist; the reader is pointed at an ADR that does not govern workflow authoring/execution. | found | false | null | cross-lane-c (broken path) — H3 should adjudicate lane assignment. Risk escalation: a Plan-017 implementer following this pointer hits a 404 and learns ADR-020 governs deployment — potentially misleads implementation of workflow authoring. |

## Pre-seeded findings verification

- **SHF-preseed-001** (Lane L primary; possibly cross-cutting with Lane A): verified `confirmed-deferred`. No SQLite STRICT ADR has been drafted. Grep over `docs/decisions/` for `STRICT` returned zero matches. Plan-017's schema file `docs/architecture/schemas/local-sqlite-schema.md` contains zero `STRICT` references. Spec-017 lines 42 and 377 explicitly carry the deferral with primary-source citations (Wave 2 §4.1, BL-097). `remediation-status: deferred`.

## Notable MATCHes (summarized; authoritative tracking at H3)

- **All 20 `accepted` ADRs**: header Status matches Decision Log terminal row. No drift.
- **ADR-013 `reserved-skipped`**: sentinel status matches its declared-reserved state; no Amendment History or Decision Log required.
- **ADR-015 amendment triple-alignment** (high-scrutiny per §9.1): header `Amended: 2026-04-22` (line 9) matches `## Amendment History` (line 194) matches Decision Log row (line 228–234). All three surfaces record same date (2026-04-22), same driver (BL-097 Resolution), same content (workflow V1.1→V1 promotion; feature count 16→17). Body copy at line 34 ("V1 consists of **17 features** (amended 2026-04-22 per BL-097 — was 16 at 2026-04-17 acceptance)") matches.
- **ADR-010 amendments**: ADR-010's amendments landed before ADR-015 set the §Amendment History precedent on 2026-04-22; ADR-010 does not have an Amendment History section but its Decision Log carries the terminal post-amendment row. No internal drift (per advisor's §9.1 framing — noting here for H3 traceability).

## Blockers / lane-adjudication notes surfaced for H3

1. **SHF-L-001 / SHF-L-002 cross-lane with Lane C**: both findings are simultaneously "ADR status cannot be verified because the file doesn't exist" (Lane L framing) and "internal cross-reference points at a non-existent path" (Lane C framing). Per §8 orthogonality invariant, logged here with `notes: cross-lane-c` so H3 can pick the authoritative lane without duplication.
2. **LICENSE coverage anomaly (out of Lane L scope, noted for H3 routing)**: `docs/decisions/020-v1-deployment-model-and-oss-license.md` Decision Log records `2026-04-17 LICENSE committed`, and `LICENSE` exists at repo root dated Apr 17 2026 (Apache 2.0). Scope doc §10.3 frames LICENSE commit as "Session H-final (1/2)" planned work. This tension is a Lane E (coverage/orphan) or plan-coverage concern, not Lane L — surfacing only so H3 can route to the owning lane.
3. **Absence of amendment-history sections on ADRs with historical amendments** (notably ADR-010): not logged as drift per advisor's framing — ADR-015 is the first ADR to introduce the §Amendment History template (2026-04-22), post-dating ADR-010's amendments. Internal status alignment is preserved. Flagged here only as a template-consistency observation H3 may weigh at retroactive-backfill-vs-going-forward discretion.
