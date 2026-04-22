# BL-097 Wave 2 Synthesis — Design-Decisions Doc for ADR-015 Amendment + Spec-017 Rewrite

**Date:** 2026-04-22
**Task:** Wave 2 synthesis (task #25). Consolidate Pass F (events), Pass G (persistence), Pass H (testing) into the single design-decisions doc that feeds ADR-015 amendment (#26), Spec-017 rewrite (#27), Plan-017 rewrite (#28), and downstream doc updates (#29, #30).
**Citations:** Every load-bearing Wave 2 decision below carries inline primary-source references resolvable in §7 References. Wave 1 citations live in the individual Pass A-E files under `docs/research/bl-097-workflow-scope/`; Wave 2 synthesis does not re-cite frozen Wave 1 sources inline but references Wave 1 Pass files where decisions build on them.

---

## 1. Source Passes + Downstream Doc Traceability

| Pass | Topic | File | Lines | Feeds downstream doc |
|---|---|---|---|---|
| F | Event taxonomy + observability | `pass-f-event-taxonomy.md` | 427 | Spec-017 §Events, ADR-018 envelope MINOR bump, Spec-006 category addendum |
| G | Persistence model | `pass-g-persistence-model.md` | 549 | Plan-017 §Schema, Plan-015 §Replay integration, Plan-014 §Artifact-ref integration |
| H | Testing + verification strategy | `pass-h-testing-strategy.md` | 458 | Plan-017 §Testing, CI pipeline config, Plan-015 §Replay-corpus ownership |

Wave 1 Pass A-E (execution semantics, multi-agent channels, human phase UX, freeze-regret patterns, security surface) remain the source-of-truth for invariants C-1 through C-16 and I1-I7. Wave 2 inherits those commitments and does not re-open them.

**Scope note on citation discipline (per memory `feedback_citations_in_downstream_docs`):** All downstream docs (ADR-015 amendment, Spec-017 rewrite, Plan-017 rewrite, v1-feature-scope.md update, ADR-020 cross-references, BL-097 Resolution block) must carry primary-source citations for each load-bearing decision. This synthesis carries all citations forward inline so downstream authors can copy-paste decision rows with their substantiating sources attached.

---

## 2. Wave 2 Commitments Landed

### 2.1 Event taxonomy (Pass F)

**Envelope discipline:** 24 new workflow event types land as *payloads* inside the existing Spec-006 `EventEnvelope` ([Spec-006](../specs/006-session-event-taxonomy-and-audit-log.md)); no new envelope schema. `causationId` on envelope carries parent-event relationships; `workflow_run_id` / `phase_run_id` are payload fields. This is an additive MINOR envelope bump under ADR-018 discipline ([ADR-018](../../decisions/018-cross-version-compatibility.md)).

**Category split — 5 new Spec-006 categories** instead of one monolithic `workflow_lifecycle`: `workflow_lifecycle`, `workflow_phase_lifecycle`, `workflow_parallel_coordination`, `workflow_channel_coordination`, `workflow_gate_resolution`. Scope-of-query split matches Spec-006's existing `run_lifecycle` / `approval_flow` pattern. No collision with existing `presence.*`, `run.*`, `approval.*`, `channel.*`, `recovery.*` categories.

**Reverse-DNS `workflow.*` namespace** convention per CloudEvents §3.1.1 ([CloudEvents v1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md)).

**Retry creates new `phaseRunId`** convention per Temporal Event History ([Temporal Events and Event History](https://docs.temporal.io/workflow-execution/event), [Temporal Encyclopedia — Event History](https://docs.temporal.io/encyclopedia/event-history)). Resolved deterministically (§3.1 below).

**Parallel cancellation fires one coordinator event + per-sibling event chains** at deterministic tick-boundary per Pass A §3.5 discipline, avoiding non-determinism class documented in Temporal Java SDK #902.

**Load-bearing event ordering invariants** ([Temporal Events Reference](https://docs.temporal.io/references/events)):
- `workflow.phase_admitted` precedes `workflow.phase_started` (resource-pool admission required first)
- `workflow.phase_cancelling` precedes `workflow.phase_failed` when `cancellation_reason != null`
- `workflow.gate_resolved` with `scope: workflow-phase` precedes the subsequent `workflow.phase_started`
- `workflow.channel_created_for_phase` precedes any events with matching `channelId`

**OpenTelemetry stance:** V1 ships ahead of OTel workflow semconv (not yet ratified as of 2026-04-22 per [OpenTelemetry GenAI Observability Blog 2025](https://opentelemetry.io/blog/2025/ai-agent-observability/)); CloudEvents + Spec-006 envelope carry the necessary structure. When OTel semconv ratifies, a future MINOR bump can add `traceparent` carriage per CloudEvents [Documented Extensions v1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/documented-extensions.md).

**`human_phase_escalated` is telemetry-only in V1** per SA-11 and Wave 1 §5.1; no `nextAction` pre-declaration (strict ADR-018 additive discipline — adding fields is always allowed later).

### 2.2 Persistence model (Pass G)

**Schema: 9 normalized SQLite tables + WAL mode** ([SQLite WAL](https://www.sqlite.org/wal.html)):

| Table | Truth / Projection / Ephemeral | Purpose |
|---|---|---|
| `workflow_definitions` | **Truth** (immutable, content-hashed) | Workflow source-of-truth definition storage |
| `workflow_versions` | **Truth** (immutable) | Version history referencing parent-version hash |
| `phase_outputs` | **Truth** (immutable per C-9) | Phase output rows; retry creates new row |
| `workflow_gate_resolutions` | **Truth** (append-only hash-chained per C-13) | Gate resolution audit log |
| `workflow_runs` | Projection (rebuildable) | Top-level run rows with transitions counter, deadline, status |
| `workflow_phase_states` | Projection | Per-phase state machine rows |
| `parallel_join_state` | Projection | Sibling-phase bookkeeping for ParallelJoinPolicy |
| `workflow_channels` | Projection | `phase_run_id` ↔ `channel_id` mapping (OWN-only V1) |
| `human_phase_form_state` | **V1 ships empty** (reserved for V1.x daemon-side drafts) | Optional autosave; zero migration cost |

**Normalized over JSON-blob** — 6 counterarguments in Pass G §4 including: replay determinism requires projection anyway; C-9 immutability + retry fights blob writes; index-friendliness load-bearing for V1 UX; per-row hash chains incompatible with blob; WAL batching amortizes blob's atomic-write advantage away; single-writer serializes already. Argo Workflows' forced blob→normalized migration is convergent precedent ([Argo — Offloading Large Workflows](https://argo-workflows.readthedocs.io/en/latest/offloading-large-workflows/), [Argo — Persistence and Archiving](https://deepwiki.com/argoproj/argo-workflows/2.9-persistence-and-archiving)).

**Hash-chain anchored to Spec-006's existing BLAKE3 + Ed25519 + RFC 8785 JCS scheme** — not a new SHA-256 scheme. Per-`workflow_run_id` chain (not per-session). Flat chain (not Merkle tree) appropriate at V1 write volume per [Crosby & Wallach 2009](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf) and [AuditableLLM MDPI 2025](https://www.mdpi.com/2079-9292/15/1/56). Dual anchoring: each gate-resolution row also carries a `session_events` row whose payload holds the `row_hash` — [Google Trillian](https://google.github.io/trillian/docs/TransparentLogging.html) pre-ordered-log pattern at smaller scale.

**Write amplification:** ~42 KB / 110 writes per 10-phase workflow; fits 2–3 Spec-015 batches under `synchronous=FULL` WAL mode. Full projection in Pass G §7.

**Driver: better-sqlite3 v12.9.0** for V1 transactional semantics ([better-sqlite3 API docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)); `db.transaction(fn)` atomicity + `.backup()` contract align with Plan-015 recovery.

**Source-of-truth hierarchy (load-bearing for replay):** `session_events` + 3 immutable truth tables + `workflow_gate_resolutions` chain = authoritative. Projection tables are rebuildable via `ProjectionRebuild` ([Temporal blog — Custom persistence layer 2024](https://temporal.io/blog/higher-throughput-and-lower-latency-temporal-clouds-custom-persistence-layer)). Pool reservation state is ephemeral; re-requested on daemon restart.

### 2.3 Testing strategy (Pass H)

**Five test categories** with V1 ambition levels (Foundational / Hardened / Continuous):

| Category | Tooling | V1 target |
|---|---|---|
| Property-based | `fast-check` with `fc.commands` for stateful ([fast-check — Model-based testing](https://fast-check.dev/docs/advanced/model-based-testing)) | 10k runs nightly, 100 runs per PR |
| Fuzz | `Jazzer.js` (coverage-guided, v4.x) with `FuzzedDataProvider` ([Jazzer.js docs](https://github.com/CodeIntelligenceTesting/jazzer.js)) | 2h/target nightly, 15m/target per PR |
| Load | `vitest bench` + `autocannon` | 30m baseline nightly |
| Integration (compressed) | `vitest` + test-daemon fixture | 20m per merge |
| Integration (real-time, multi-day) | scheduled nightly runner | 7d weekly real-time human-phase resume |
| Security regression | per-invariant I1-I7 assertion suites + CVE-specific corpora | Gate on every PR |

**Replay testing via Temporal `runReplayHistory` pattern** ([Temporal TypeScript SDK Testing](https://docs.temporal.io/develop/typescript/testing-suite), [Bitovi — Replay Testing](https://www.bitovi.com/blog/replay-testing-to-avoid-non-determinism-in-temporal-workflows)): CI replays recorded workflow histories and fails on `DeterminismViolationError`.

**Security regression battery covers every invariant I1-I7** from Pass E with explicit CVE-reproducer corpora: [GitHub Actions script-injection](https://docs.github.com/en/actions/concepts/security/script-injections) for I1; [Airflow secret-masker #54540](https://github.com/apache/airflow/issues/54540) encoding-bypass for I4; [OWASP File Upload Cheat Sheet 2025](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) for I6; [Endor Labs CVE-2025-66626 Argo broken-fix analysis](https://www.endorlabs.com/learn/when-a-broken-fix-leads-to-rce-how-we-found-cve-2025-66626-in-argo) for archive-symlink traversal; [n8n CVE-2025-68613 advisory](https://github.com/n8n-io/n8n/security/advisories/GHSA-v98v-ff95-f3cp) for expression-escape.

**Coverage targets:** 85% line overall, 95% line + 90% branch on security-critical modules (parser, secrets resolver, approval log, executor tick loop). Mutation-testing intent: every invariant I1-I7 and every commitment C-1 through C-16 has ≥1 test that fails if the invariant is violated.

**CI pipeline structure:** PR ≤ 30 min wall-clock; nightly ≤ 8h; weekly unbounded. Fuzz corpus committed; crashers minimized and promoted to named `vitest` regression tests per `corpus/<target>/regressions/`. [Astronomer — Testing Airflow DAGs](https://www.astronomer.io/docs/learn/testing-airflow) provides DAG-validation prior art.

---

## 3. Open-Question Resolution (Themed)

26 cross-pass open questions from F/G/H subagents consolidated into 6 themes. Each theme lands a decision; the sub-items table provides traceability to source Pass questions.

### 3.1 Retry + replay determinism

**Resolution:** Retry creates a new `phaseRunId` generated deterministically as `BLAKE3(workflowRunId || phaseDefinitionId || attemptNumber)`. Replay reproduces the same `phaseRunId` sequence; random ULIDs forbidden for `phaseRunId`. `session_events` + immutable truth tables are the replay authority; projection tables rebuild via `ProjectionRebuild`. Parallel cancellation emits deterministic tick-boundary events only.

**Citations:** [Temporal Encyclopedia — Event History](https://docs.temporal.io/encyclopedia/event-history), [Bitovi Replay Testing](https://www.bitovi.com/blog/replay-testing-to-avoid-non-determinism-in-temporal-workflows), Pass A §3.5 tick discipline.

| Source question | Sub-resolution |
|---|---|
| F.7.7 — deterministic `phaseRunId` on replay | ✓ `BLAKE3(...)` generator spec; pinned in Spec-017 |
| H.10.7 — determinism oracle for parallel executor | ✓ Logical state determinism asserted; wall-clock timing explicitly out of scope |
| H.10.2 — replay-corpus sourcing | Plan-015 owns corpus recording; Pass F event schema is the shape contract. New follow-up task proposed in §4 |
| G.10.4 — rebuild-from-event-payload path for `workflow_gate_resolutions` | ✓ Added to Plan-015 rebuild-paths scope; hash-chain verification on replay per Pass G §8 |

### 3.2 Observability cadence

**Resolution:** `phase_progressed` cadence is phase-type-specific — `single-agent`/`automated` emit on turn completion + tool-invocation boundary; `multi-agent` emit on channel-turn boundary + 25/50/75% of `turns_per_agent` budget milestones; `human` emit on form-section save + claim/re-claim. `phase_waiting_on_pool` emits on entry-to-blocked state + at 30s intervals while blocked (tripwire-configurable); Pass G stores aggregate `totalPoolWaitMs` on phase row, not per-wait rows. `workflow.resumed` carries structured `resumptionPoint: {activePhaseRunIds, pendingGates}` for reader-reconstruction speed.

**Citations:** [n8n Workflow Executions](https://docs.n8n.io/workflows/executions/), [OpenTelemetry SemConv for Events](https://opentelemetry.io/docs/specs/semconv/general/events/) (low-cardinality naming rule).

| Source question | Sub-resolution |
|---|---|
| F.7.2 — `phase_waiting_on_pool` cadence | ✓ Entry + 30s intervals with `waitingSinceSeq` |
| F.7.5 — `phase_progressed` granularity | ✓ Phase-type-specific cadence |
| F.7.6 — `workflow.resumed` `resumptionPoint` payload | ✓ Structured payload included |

### 3.3 Hash-chain scheme selection

**Resolution:** Daemon-internal identity hashes (e.g., `workflow_definitions.content_hash`, `phaseRunId` generator) use **BLAKE3** for Spec-006 consistency. Plan-014 artifact-manifest content hashes continue using **SHA-256** per existing Plan-014 contract. This is deliberate dual-algorithm: BLAKE3 for daemon-internal constructs tied to Spec-006's chain; SHA-256 for externally-referenced artifacts where ecosystem interop matters.

**Citations:** [Crosby & Wallach 2009](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf) + [AuditableLLM MDPI 2025](https://www.mdpi.com/2079-9292/15/1/56) for the flat-chain / tamper-evident reasoning; Spec-006 for BLAKE3 + Ed25519 + RFC 8785 JCS anchor; Plan-014 for SHA-256 artifact-manifest contract.

| Source question | Sub-resolution |
|---|---|
| G.10.5 — `workflow_definitions.content_hash` scheme | ✓ BLAKE3 for daemon-internal; SHA-256 stays Plan-014 |

### 3.4 V1 ship-empty tables

**Resolution:** `human_phase_form_state` ships **in V1 as empty schema**. Zero migration cost when V1.x daemon-side draft autosave lands; zero runtime cost while unused. Clients resume drafts from their own localStorage per Pass C §3. This is a deliberate V1 readiness-without-execution pattern — schema commitment without feature activation.

**Citations:** Pass C §3 client-side draft pattern; Pass G §3 table design.

| Source question | Sub-resolution |
|---|---|
| G.10.3 — `human_phase_form_state` V1 status | ✓ Ship empty |

### 3.5 Tripwire validation ownership

**Resolution:** Every Wave 1 tripwire (`RUN_ITERATION_LIMIT` >2%, `agent_memory_mb` blocked-launch >15%, join-policy-override >30%, `ParallelJoinPolicy` `any-success` usage pattern) has a corresponding V1 dashboard query and a Pass H property test that fires the tripwire event when thresholds are crossed. Tripwire firing goes through Pass F's `workflow.phase_waiting_on_pool` / `workflow.parallel_join_cancellation` / new telemetry events; Pass H asserts firing via event-log assertion. Daemon does NOT auto-escalate on tripwire fire (V1 — no notification routing). V1.x may add auto-escalate.

**Citations:** Wave 1 §3 tripwire list; [GitHub Actions script-injection guidance](https://docs.github.com/en/actions/concepts/security/script-injections) (pattern for per-invariant test-fires-on-violation).

| Source question | Sub-resolution |
|---|---|
| H.10.8 — tripwire-firing validation | ✓ Pass H asserts event-log firing; V1 ops dashboards consume |
| F.7.8 — explicit `workflow.phase_deferred` event? | Deferred — current 3-terminal model sufficient unless load tests flag operator-diagnosis pain |

### 3.6 Miscellaneous technical resolutions

Catch-all for orthogonal questions with clean single-sentence answers.

| Source question | Resolution |
|---|---|
| F.7.1 — `phase_waiting_on_pool` as rows vs events | Events authoritative; phase row stores aggregate `totalPoolWaitMs` (G §3) |
| F.7.3 — `parallel_join_cancellation` cancelled-sibling payload cap | No cap V1; tripwire on >10KB serialized event; load-test reviews before V1.1 |
| F.7.4 — `human_phase_escalated` pre-declare `nextAction`? | No; strict ADR-018 additive discipline |
| G.10.2 — per-run vs per-session gate chain | Per-run (already landed in Pass G §5) |
| G.10.6 — `phase_transitions_count` CHECK behavior | Hard-fail matching Pass A §3.2 — `failure_reason='RUN_ITERATION_LIMIT'` |
| G.10.7 — pool reservation durability | Write-once reservation intent at admit time; no runtime pool-counts persistence |
| G.10.8 — retention for completed runs | Reuse Spec-022 crypto-shred; inherit Spec-015 backup policy; no engine-specific TTL |
| H.10.3 — fuzz-target coverage plateau escalation | V1 stance: plateau <70% at 2h triggers harness-review task, not CI fail |
| H.10.4 — secrets-canary in Electron renderer | Out of scope here; Plan-001 owns IPC secret contract |
| H.10.5 — weekly real-time integration runner | Self-hosted runner required (GitHub Actions free tier 6h limit); V1 deploy via Plan-015 infra |
| H.10.6 — property test for gate-scoping lattice (SA-7) | Added to Pass H §2 explicit properties; implementation at Plan-017 §Testing |
| H.10.9 — corpus poisoning CI DoS | PR fuzz budget hard-capped 15m/target; corpus changes require CODEOWNERS review |
| H.10.10 — chaos / fault-injection layer | V1 scope excluded; Plan-015 owns SQLite-corruption / disk-full fault injection |

---

## 4. Cross-Cutting ADR Candidates

Wave 2 surfaced two candidates that are broader than Plan-017 scope. Per memory `feedback_criterion_gated_deferrals`, both get explicit treatment — not silent absorption.

### 4.1 SQLite STRICT tables adoption policy (from G.10.1)

**Decision: Criterion-gated V1.x deferral.** Plan-017 Wave 2 schema uses the repo's existing TEXT-column convention (no STRICT). SQLite 3.37+ STRICT would be a cross-plan policy change affecting Plan-015, Plan-017, and any future plans using SQLite. Adopting at V1 introduces migration burden across plans already frozen.

**Criterion-gated V1.x commitment language for ADR-015:**
> SQLite STRICT tables adoption (committed V1.x), contingent on:
> (a) ≥1 type-confusion bug documented in V1 testing or production, AND
> (b) cross-plan STRICT migration cost assessed via new ADR-XXX draft, AND
> (c) Plan-015 / Plan-017 schema evolution path proven via migration fixture.

**New task recommended before Plan-017 freeze:** Spawn **task #32 — Draft cross-cutting SQLite STRICT policy ADR** (non-blocking for ADR-015 / Spec-017; parallel work).

### 4.2 Mutation testing (stryker-mutator) in V1 (from H.10.1)

**Decision: Criterion-gated V1.x deferral.** Mutation testing would validate that the test suite actually fails when code is mutated — highest-value test-quality signal. 5–20 min PR cost is significant; V1 CI budget already at PR ≤ 30 min. Adopting at V1 risks pushing PR pipeline over budget and creating merge friction.

**Criterion-gated V1.x commitment language for ADR-015:**
> Mutation testing (committed V1.x), contingent on:
> (a) V1 property-based + fuzz test surface baseline in steady-state, AND
> (b) CI capacity uplift (self-hosted runner or tier upgrade) documented, AND
> (c) representative mutation-survival baseline from weekly nightly runs published for at-least-one V1 release cycle.

**No new task required.** V1 ships with the `§8 mutation-testing-intent` code-review-gate; `stryker-mutator` itself ships V1.x per criteria.

---

## 5. Spec-017 Amendments Extension (SA-18 through SA-31)

Extends Wave 1's SA-1 through SA-17. Each new amendment cites source Pass + primary source.

| # | Amendment | Pass source | Primary citation |
|---|---|---|---|
| SA-18 | Add 5 new Spec-006 event categories: `workflow_lifecycle`, `workflow_phase_lifecycle`, `workflow_parallel_coordination`, `workflow_channel_coordination`, `workflow_gate_resolution` | Pass F §1 | [CloudEvents v1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md) |
| SA-19 | Add 24 event-type payload schemas under `workflow.*` reverse-DNS namespace | Pass F §2 | [Temporal Events Reference](https://docs.temporal.io/references/events) |
| SA-20 | Ordering invariant contract language for phase/gate/channel event sequences | Pass F §3 | [Temporal Events and Event History](https://docs.temporal.io/workflow-execution/event) |
| SA-21 | Deterministic `phaseRunId` generator spec: `BLAKE3(workflowRunId \|\| phaseDefinitionId \|\| attemptNumber)` | Pass F §3.1, Pass G §5 | [Temporal Encyclopedia](https://docs.temporal.io/encyclopedia/event-history), [Crosby & Wallach 2009](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf) |
| SA-22 | `phase_progressed` per-phase-type cadence contract | Pass F §7.5 resolved | [n8n Executions](https://docs.n8n.io/workflows/executions/) |
| SA-23 | `phase_waiting_on_pool` entry + 30s-interval cadence with `waitingSinceSeq` | Pass F §7.2 resolved | [OpenTelemetry SemConv for Events](https://opentelemetry.io/docs/specs/semconv/general/events/) |
| SA-24 | 9-table SQLite schema (`workflow_definitions`, `workflow_versions`, `phase_outputs`, `workflow_gate_resolutions`, `workflow_runs`, `workflow_phase_states`, `parallel_join_state`, `workflow_channels`, `human_phase_form_state`) | Pass G §2 | [SQLite WAL](https://www.sqlite.org/wal.html), [better-sqlite3 docs](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md) |
| SA-25 | Source-of-truth vs projection vs ephemeral hierarchy + `ProjectionRebuild` contract | Pass G §1, §8 | [Temporal Custom Persistence blog 2024](https://temporal.io/blog/higher-throughput-and-lower-latency-temporal-clouds-custom-persistence-layer) |
| SA-26 | Hash-chain scheme: per-run flat chain anchored to Spec-006 BLAKE3 + Ed25519 + RFC 8785 JCS; dual anchor via `session_events` payload | Pass G §5 | [Crosby & Wallach 2009](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf), [AuditableLLM MDPI 2025](https://www.mdpi.com/2079-9292/15/1/56), [Google Trillian](https://google.github.io/trillian/docs/TransparentLogging.html) |
| SA-27 | Dual-hash algorithm: BLAKE3 for daemon-internal identity; SHA-256 reserved for Plan-014 artifact-manifest content | Pass G §5, §10.5 resolved | Plan-014, Spec-006 |
| SA-28 | `human_phase_form_state` table ships empty at V1 (reserved for V1.x daemon-side drafts) | Pass G §10.3 resolved | Pass C §3 client-side draft pattern |
| SA-29 | Testing strategy: 5 categories with V1 ambition levels + coverage targets (85/95/90) | Pass H §1, §8 | [fast-check](https://fast-check.dev/docs/advanced/model-based-testing), [Jazzer.js](https://github.com/CodeIntelligenceTesting/jazzer.js) |
| SA-30 | Security regression battery: per-invariant I1-I7 assertion suites + CVE-reproducer corpora | Pass H §6 | [OWASP File Upload 2025](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html), [Endor CVE-2025-66626](https://www.endorlabs.com/learn/when-a-broken-fix-leads-to-rce-how-we-found-cve-2025-66626-in-argo) |
| SA-31 | Replay-testing contract: Temporal `runReplayHistory` pattern for `DeterminismViolationError` assertion | Pass H §5 | [Temporal TS SDK Testing](https://docs.temporal.io/develop/typescript/testing-suite), [Bitovi Replay Testing](https://www.bitovi.com/blog/replay-testing-to-avoid-non-determinism-in-temporal-workflows) |

Total Spec-017 amendments with Wave 1's SA-1…SA-17: **31 amendments**. Each carries inline primary-source citation for downstream doc copy-paste.

---

## 6. Open Decisions for User

**Wave 2 resolved all technical questions; no product calls required before ADR-015 amendment (task #26) proceeds.**

Honest audit per advisor guidance: 26 cross-pass open questions were triaged into §3 (themed resolutions), §4 (cross-cutting ADR candidates, both criterion-gated deferrals), and catch-all §3.6. All resolutions are technically-grounded. No product/UX trade-offs surfaced that require user judgment beyond what D1/D2 in Wave 1 synthesis already captured.

One optional product signal for user awareness (not a blocker):

- **Task #32 (SQLite STRICT policy ADR) recommendation** — §4.1 above proposes a new parallel task for a cross-cutting SQLite STRICT adoption ADR. This is a scope-hygiene recommendation, not a scope-expansion: STRICT adoption was correctly scoped out of Plan-017 per criterion-gated V1.x deferral. The new task captures *when* to revisit, not *whether* to defer. User may ratify or decline without affecting BL-097 timeline.

---

## 7. References

All primary sources consulted 2026-04-22 or at noted date markers. Wave 1 citations live in Pass A-E files under `docs/research/bl-097-workflow-scope/` and are not duplicated here.

**Event taxonomy (Pass F):**

1. [CloudEvents Specification v1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md) — ratified 2022, referenced throughout 2024-2026
2. [CloudEvents Documented Extensions v1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/documented-extensions.md)
3. [OpenTelemetry Semantic Conventions for Events](https://opentelemetry.io/docs/specs/semconv/general/events/) — 2025
4. [OpenTelemetry GenAI Observability Blog](https://opentelemetry.io/blog/2025/ai-agent-observability/) — 2025
5. [Temporal — Events and Event History](https://docs.temporal.io/workflow-execution/event) — accessed 2026-04-22
6. [Temporal Events Reference](https://docs.temporal.io/references/events) — accessed 2026-04-22
7. [Temporal Encyclopedia — Event History](https://docs.temporal.io/encyclopedia/event-history) — accessed 2026-04-22
8. [Argo Workflows — Workflow Events](https://argo-workflows.readthedocs.io/en/latest/workflow-events/) — accessed 2026-04-22
9. [n8n Workflow Executions Docs](https://docs.n8n.io/workflows/executions/) — accessed 2026-04-22
10. [CloudEvents Subject Field Prior Art (GitHub #112)](https://github.com/cloudevents/spec/issues/112) — 2019-ongoing pattern

**Persistence model (Pass G):**

11. [Temporal blog — Custom persistence layer 2024](https://temporal.io/blog/higher-throughput-and-lower-latency-temporal-clouds-custom-persistence-layer)
12. [Restate — Building a modern durable-execution engine from first principles](https://www.restate.dev/blog/building-a-modern-durable-execution-engine-from-first-principles) — 2025
13. [SQLite — Write-Ahead Logging](https://www.sqlite.org/wal.html) + [SQLite JSON1](https://sqlite.org/json1.html)
14. [Crosby & Wallach — Efficient Data Structures for Tamper-Evident Logging (USENIX 2009)](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf)
15. [AuditableLLM — MDPI Electronics Dec 2025](https://www.mdpi.com/2079-9292/15/1/56)
16. [Google Trillian — Transparent Logging](https://google.github.io/trillian/docs/TransparentLogging.html)
17. [Argo Workflows — Persistence and Archiving](https://deepwiki.com/argoproj/argo-workflows/2.9-persistence-and-archiving) + [Offloading Large Workflows](https://argo-workflows.readthedocs.io/en/latest/offloading-large-workflows/)
18. [Cadence — Persistence docs](https://github.com/cadence-workflow/cadence/blob/master/docs/persistence.md)
19. [better-sqlite3 API docs v12.9.0 (2026-04-12)](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)

**Testing strategy (Pass H):**

20. [fast-check — Model-based testing](https://fast-check.dev/docs/advanced/model-based-testing)
21. [Jazzer.js — coverage-guided Node.js fuzzing (Code Intelligence)](https://github.com/CodeIntelligenceTesting/jazzer.js)
22. [GitHub Actions script-injection guidance](https://docs.github.com/en/actions/concepts/security/script-injections) — 2025
23. [Airflow secret masker issue `apache/airflow#54540`](https://github.com/apache/airflow/issues/54540) — 2025
24. [Temporal TypeScript SDK — Testing Suite](https://docs.temporal.io/develop/typescript/testing-suite)
25. [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html) — 2025
26. [Endor Labs — CVE-2025-66626 Argo broken-fix analysis](https://www.endorlabs.com/learn/when-a-broken-fix-leads-to-rce-how-we-found-cve-2025-66626-in-argo)
27. [Astronomer — Testing Airflow DAGs](https://www.astronomer.io/docs/learn/testing-airflow)
28. [Temporal blog — Replay Testing (Bitovi)](https://www.bitovi.com/blog/replay-testing-to-avoid-non-determinism-in-temporal-workflows)
29. [n8n `CVE-2025-68613` advisory](https://github.com/n8n-io/n8n/security/advisories/GHSA-v98v-ff95-f3cp)

**Wave 1 reference sources (inherited, not re-cited inline):**

- Wave 1 synthesis: `docs/research/bl-097-workflow-scope/wave-1-synthesis.md`
- Pass A (parallel execution): `pass-a-parallel-execution.md` §6 citations
- Pass B (multi-agent channels): `pass-b-multi-agent-channel-contract.md` §6 citations
- Pass C (human phase UX): `pass-c-human-phase-ux.md` §6 citations
- Pass D (freeze-regret patterns): `pass-d-post-v1-freeze-regrets.md` §6 citations
- Pass E (security surface): `pass-e-security-surface.md` §6 citations

*End of Wave 2 synthesis. Feeds task #26 (ADR-015 amendment), task #27 (Spec-017 rewrite), task #28 (Plan-017 rewrite); proposed task #32 (cross-cutting SQLite STRICT policy ADR) is non-blocking parallel work.*
