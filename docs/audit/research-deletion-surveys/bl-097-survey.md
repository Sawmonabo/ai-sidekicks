# BL-097 Workflow-Scope Research — Embed-Worthy Citation Survey (T11)

**Task:** T11 of the research-deletion architectural cleanup. Survey all 10 files in `docs/research/bl-097-workflow-scope/` for embed-worthy external (primary-source) citations and map them to the four canonical destination docs so T14–T18 can land them before research/ is deleted.

**Strategy:** `surface-external-citations` — extract verifiable URL-resolvable citations only; do not absorb prose. Section-level destination targeting per Pass.

**Scope of source files surveyed (all confirmed extant via Glob, all read in full pre-compaction):**

| File | Lines | Status |
|---|---|---|
| `pass-a-parallel-execution.md` | 358 | Read |
| `pass-b-multi-agent-channel-contract.md` | 358 | Read |
| `pass-c-human-phase-ux.md` | 396 | Read |
| `pass-d-post-v1-freeze-regrets.md` | 561 | Read |
| `pass-e-security-surface.md` | 435 | Read |
| `pass-f-event-taxonomy.md` | 428 | Read |
| `pass-g-persistence-model.md` | 550 | Read |
| `pass-h-testing-strategy.md` | 459 | Read |
| `wave-1-synthesis.md` | 248 | Read |
| `wave-2-synthesis.md` | 297 | Read |

**Destination doc patterns confirmed (per T11 spec):**
- **ADR-015** — canonical 4-column `### Research Conducted` table (`Source | Type | Key Finding | URL/Location`); pattern matches ADR-016 lines 151–178 + ADR-017 lines 111–137. ADR-015 currently has a `BL-097 Research Provenance` *list* but no Research Conducted *table*.
- **Spec-017** — Spec-015 inline-citation pattern (extraction quote + parenthetical citation in body prose) PLUS topical `## References` groups at end-of-file (lines 389–478). ~35 external citations already landed; Pass A/B/C/E/F/G/H bibliography is largely absorbed.
- **Plan-017** — Plan-024 flat-list `## References` at end-of-file pattern (Plan-024 lines 187+). Plan-017 currently has inline CVE links in its Test table but **no end-of-file References section** — would need to be created by T16-T18.
- **`local-sqlite-schema.md`** — currently only references research-internal pointers (lines 389, 681, 683); needs primary-source citations from Pass G §9 inserted to survive research/ deletion.

---

## §1 — Per-Pass Bibliography + Section-Level Destination Map

For each Pass, citations are bucketed into **load-bearing** (anchors a contract commitment Cn, security invariant In, amendment SAn, or schema decision; deletion would lose verifiability) vs **redundant** (already covered by a stronger source elsewhere; safe to drop).

Section-level targets use the actual destination doc structure as of 2026-04-25.

### §1.1 — Wave 1 Synthesis (`wave-1-synthesis.md`)

Wave 1 is itself the synthesis memo for ADR-015's Amendment History; it contains few unique external citations not already in Passes A–E. **Zero unique externals.** Wave 1 is fully a synthesis artifact.

**Destination:** ADR-015 only.

**Status:** All Wave 1 references are pointers into Passes A–E plus internal cross-refs. **No embed-worthy externals**; Wave 1's role on deletion is replaced by the new ADR-015 §Research Conducted table (the table replaces the synthesis memo as a citation-anchor surface).

### §1.2 — Wave 2 Synthesis (`wave-2-synthesis.md`)

Wave 2 §7 References lists 29 numbered primary sources. Most are already absorbed in Spec-017 lines 419–475 and `local-sqlite-schema.md` line 11 (`synchronous=FULL` rationale). Surfaced unique-to-Wave-2 externals:

| Citation | URL | Type | Anchors | Destination |
|---|---|---|---|---|
| CloudEvents v1.0.2 spec | https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md | spec | SA-18 envelope additive bump | **ADR-015 §Research Conducted** + already in Spec-017 |
| OpenTelemetry Semantic Conventions for Events | https://github.com/open-telemetry/semantic-conventions/blob/main/docs/general/events.md | spec | SA-19 event-name convention | **ADR-015 §Research Conducted** + already in Spec-017 |
| Temporal Events Reference | https://docs.temporal.io/references/events | spec | SA-20 reserved-event list | **ADR-015 §Research Conducted** + already in Spec-017 |
| SQLite WAL docs | https://www.sqlite.org/wal.html | spec | Pragma rationale (already in Spec-015 §Pragmas) | **ADR-015 §Research Conducted** (redundant in Spec-017) |
| Crosby & Wallach 2009 — Efficient Data Structures for Tamper-Evident Logging | https://www.usenix.org/legacy/event/sec09/tech/full_papers/crosby.pdf | paper | C-13 hash-chain + I7 append-only | **ADR-015 §Research Conducted** + already in Spec-017 |
| AuditableLLM (MDPI 2025) | https://www.mdpi.com/2079-9292/14/10/2059 | paper | C-13 LLM audit-log precedent | **ADR-015 §Research Conducted** |
| Google Trillian (transparency log) | https://github.com/google/trillian | code | C-13 hash-chain operational precedent | **ADR-015 §Research Conducted** |
| fast-check (model-based testing) | https://github.com/dubzzz/fast-check | code | SA-29 property-test framework | **ADR-015 §Research Conducted** + Plan-017 §References |
| Jazzer.js (fuzzing) | https://github.com/CodeIntelligenceTesting/jazzer.js | code | SA-29 fuzz-test framework | **ADR-015 §Research Conducted** + Plan-017 §References |
| OWASP File Upload Cheat Sheet | https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html | spec | I6 human-upload minimums | **ADR-015 §Research Conducted** + already in Spec-017 + Plan-017 |
| `better-sqlite3` v12.9.0 (2026-04-12) | https://github.com/WiseLibs/better-sqlite3 | code | Pin rationale | already in Spec-015 — **redundant**; do not re-cite |

**Total Wave 2 unique externals: 10** (excluding 3 already landed in Spec-015).

**Destination:** ADR-015 only.

### §1.3 — Pass A: Parallel Execution (`pass-a-parallel-execution.md`)

Pass A §7 has ~30 citations. Load-bearing externals anchoring Wave-1 commitments C-3 (DAG executor), SA-1 (max_phase_transitions), SA-3 (resource pools), SA-4 (ParallelJoinPolicy):

| Citation | URL | Type | Anchors | Destination |
|---|---|---|---|---|
| Apache Airflow DAG source | https://github.com/apache/airflow/blob/main/airflow/models/dag.py | code | Kahn's-algorithm precedent (DAG executor) | **ADR-015 §Research Conducted** + Spec-017 §References > Execution semantics |
| Airflow Pools docs | https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/pools.html | spec | SA-3 resource-pool precedent | **ADR-015 §Research Conducted** + Spec-017 §References > Execution semantics |
| Astronomer trigger rules | https://www.astronomer.io/docs/learn/managing-dependencies | spec | C-3 trigger rules | **ADR-015 §Research Conducted** + Spec-017 §References > Execution semantics |
| `apache/airflow#4322` (DAG run conf) | https://github.com/apache/airflow/issues/4322 | issue | DAG re-run semantics | Spec-017 §References > Execution semantics (skip ADR — too narrow) |
| Temporal Go SDK (workflow primitives) | https://docs.temporal.io/develop/go | spec | C-3 durable execution | **ADR-015 §Research Conducted** + already in Spec-017 |
| Temporal Child Workflows | https://docs.temporal.io/develop/typescript/child-workflows | spec | C-7 sub-workflow contract | already in ADR-015 Amendment History — redundant |
| `temporalio/sdk-java#902` | https://github.com/temporalio/sdk-java/issues/902 | issue | Child workflow cancellation | Spec-017 §References > Execution semantics |
| Argo Workflows parallelism | https://argo-workflows.readthedocs.io/en/latest/walk-through/parallelism/ | spec | SA-3 parallelism budget | **ADR-015 §Research Conducted** + Spec-017 §References > Execution semantics |
| `argoproj/argo-workflows#11984` | https://github.com/argoproj/argo-workflows/issues/11984 | issue | Parallelism backpressure regression | Spec-017 §References > Execution semantics |
| `argoproj/argo-workflows#740` | https://github.com/argoproj/argo-workflows/issues/740 | issue | Cross-DAG global parallelism | Spec-017 §References > Execution semantics |
| Dagster concurrency docs | https://docs.dagster.io/concepts/configuration/run-tags#run-concurrency | spec | SA-3 multi-tier resource pool precedent | **ADR-015 §Research Conducted** + Spec-017 §References > Execution semantics |
| `PrefectHQ/prefect#17867` | https://github.com/PrefectHQ/prefect/issues/17867 | issue | SA-1 iteration-budget retro-fit | Spec-017 §References > Execution semantics |
| n8n parallel-execution community thread | https://community.n8n.io/t/parallel-execution-of-workflows/57316 | issue | Parallel-execution UX gap | Spec-017 §References > Execution semantics |
| AWS Step Functions error handling | https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html | spec | SA-4 ParallelJoinPolicy `fail-fast` precedent | **ADR-015 §Research Conducted** + Spec-017 §References > Execution semantics |
| Dagger changelog (parallelism mode) | https://github.com/dagger/dagger/blob/main/CHANGELOG.md | spec | Parallelism execution-mode break | already in ADR-015 Amendment History — redundant |

**Total load-bearing externals from Pass A: ~14.** Drop ~16 redundant (community comments, blog rehashes).

**Destination:** ADR-015 + Spec-017 (dual).

### §1.4 — Pass B: Multi-Agent Channel Contract (`pass-b-multi-agent-channel-contract.md`)

Pass B §6 has ~50 citations across 8 systems. **Pass B is the source of the BIND criteria** (a)/(b)/(c) committed in ADR-015 §V1.1 Criterion-Gated Commitments, so its load-bearing externals anchor that commitment + SA-6 (ownership: OWN V1):

| Citation | URL | Type | Anchors | Destination |
|---|---|---|---|---|
| Temporal ParentClosePolicy | https://docs.temporal.io/develop/typescript/child-workflows#parent-close-policy | spec | SA-6 OWN-only V1; child-close behavior | **ADR-015 §Research Conducted** |
| Airflow 2.0 release blog | https://airflow.apache.org/blog/airflow-2.0/ | post | Sub-DAG breaking change precedent | **ADR-015 §Research Conducted** |
| `apache/airflow#1350` (SubDAG removal) | https://github.com/apache/airflow/issues/1350 | issue | Sub-DAG break | **ADR-015 §Research Conducted** |
| `apache/airflow#12292` (TaskGroup precedent) | https://github.com/apache/airflow/issues/12292 | issue | TaskGroup-vs-SubDAG break | already in ADR-015 Amendment History — redundant |
| Astronomer Airflow 2.0 upgrade guide | https://www.astronomer.io/docs/learn/airflow-2-0/ | spec | Sub-DAG migration cost | **ADR-015 §Research Conducted** |
| Twine Labs SubDAG deadlock writeup | https://blog.twinelabs.io/blog/airflow-subdag-deadlock | post | BIND failure mode | **ADR-015 §Research Conducted** |
| n8n executeWorkflow docs | https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow/ | spec | Sub-workflow precedent | **ADR-015 §Research Conducted** |
| Activepieces SubFlows | https://www.activepieces.com/docs/automation/subflows | spec | Sub-workflow precedent | **ADR-015 §Research Conducted** |
| Argo DAG/templates/suspending walkthrough | https://argo-workflows.readthedocs.io/en/latest/walk-through/dag/ | spec | C-7 sub-workflow contract | **ADR-015 §Research Conducted** |
| `argoproj/argo-workflows#12425` | https://github.com/argoproj/argo-workflows/issues/12425 | issue | Sub-workflow lifecycle ambiguity | **ADR-015 §Research Conducted** |
| AWS Step Functions best practices | https://docs.aws.amazon.com/step-functions/latest/dg/bp-cwl.html | spec | Sub-workflow break-down precedent | **ADR-015 §Research Conducted** |
| Kai Waehner durable-execution rise | https://www.kai-waehner.de/blog/2024/02/22/the-rise-of-durable-execution/ | post | Industry framing | drop — too broad |
| Dapr workflow patterns | https://docs.dapr.io/developing-applications/building-blocks/workflow/workflow-patterns/ | spec | Sub-workflow industry alignment | **ADR-015 §Research Conducted** |

**Total load-bearing externals from Pass B: ~12.** Drop ~38 (industry blogs, community comments without primary-source authority).

**Destination:** ADR-015 only.

### §1.5 — Pass C: Human Phase UX (`pass-c-human-phase-ux.md`)

Pass C §8 has ~40 citations anchoring SA-12 (human_phase_contribution Cedar category), SA-26 (human-phase form-state lifecycle), SA-28 (form-state daemon-side V1.x deferral), and D1 resolution (no default human-phase timeout):

| Citation | URL | Type | Anchors | Destination |
|---|---|---|---|---|
| Argo suspend walkthrough | https://argo-workflows.readthedocs.io/en/latest/walk-through/suspending/ | spec | `human` phase suspend semantics | already in ADR-015 Amendment History — redundant |
| Argo intermediate-parameters | https://argo-workflows.readthedocs.io/en/latest/intermediate-inputs/ | spec | Human-phase form input pattern | Spec-017 §References > Execution semantics + human phase + Plan-017 §References |
| Argo suspend-template-outputs example | https://github.com/argoproj/argo-workflows/blob/main/examples/suspend-template-outputs.yaml | code | Output-projection-on-resume | Spec-017 §References > Execution semantics + human phase + Plan-017 §References |
| `argoproj/argo-workflows#8365` | https://github.com/argoproj/argo-workflows/discussions/8365 | issue | Form-input UX gap | Plan-017 §References (skip Spec — issue narrow) |
| Camunda 8 user tasks | https://docs.camunda.io/docs/components/modeler/bpmn/user-tasks/ | spec | Human-phase claim semantics | Spec-017 §References > Execution semantics + human phase + Plan-017 §References |
| Camunda 8 user-tasks best practices | https://docs.camunda.io/docs/components/best-practices/development/dealing-with-data-in-processes/#using-user-task-forms | spec | Form-data persistence pattern | Plan-017 §References |
| GitHub Actions reviewing deployments | https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments | spec | Approval-gate UX precedent | Spec-017 §References > Execution semantics + human phase + Plan-017 §References |
| AWS Step Functions human-approval tutorial | https://docs.aws.amazon.com/step-functions/latest/dg/sample-project-human-approval.html | spec | Approval-gate sample | Plan-017 §References |
| AWS Step Functions SendTaskHeartbeat | https://docs.aws.amazon.com/step-functions/latest/apireference/API_SendTaskHeartbeat.html | spec | Heartbeat-based liveness | Plan-017 §References |
| Temporal long-running workflows blog | https://temporal.io/blog/very-long-running-workflows | post | D1 timeout-default rationale | already in ADR-015 Amendment History — redundant |
| Temporal Python message passing | https://docs.temporal.io/develop/python/message-passing | spec | Signal-based human input | Plan-017 §References |
| Temporal HITL tutorial | https://learn.temporal.io/tutorials/typescript/human-in-the-loop/ | spec | HITL pattern | Plan-017 §References |
| Cloudflare Workflows `waitForEvent` | https://developers.cloudflare.com/workflows/build/events-and-parameters/ | spec | Wait-for-event primitive | Plan-017 §References |
| LangGraph human-in-the-loop | https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/ | spec | HITL primitive (LLM stack) | Plan-017 §References |
| Microsoft Agent Framework HITL (2026-03-31) | https://learn.microsoft.com/en-us/agent-framework/concepts/human-in-the-loop | spec | HITL primitive (recent) | Plan-017 §References |
| MCP elicitations spec | https://spec.modelcontextprotocol.io/specification/2025-06-18/server/utilities/elicitations/ | spec | SA-12 `mcp_elicitation` Cedar category overlap | Spec-017 §References > Execution semantics + human phase |
| W3C WCAG 2.2 §3.3.7 Redundant Entry | https://www.w3.org/TR/WCAG22/#redundant-entry | spec | SA-26 form-state UX requirement | Spec-017 §References > Execution semantics + human phase + Plan-017 §References |
| W3C WCAG 3 (Working Draft) | https://www.w3.org/TR/wcag-3.0/ | spec | Forward-compat reference | drop — too broad |

**Total load-bearing externals from Pass C: ~17.** Drop ~23 (Zapier/Retool/n8n community/Dhiwise blog noise).

**Destination:** Spec-017 + Plan-017 (dual).

### §1.6 — Pass D: Post-V1 Freeze Regrets (`pass-d-post-v1-freeze-regrets.md`)

Pass D §5 has ~40 citations anchoring the **core full-engine-at-V1 thesis** (every surveyed system shipped a V1 subset and broke later). Most load-bearing for ADR-015 Decision rationale:

| Citation | URL | Type | Anchors | Destination |
|---|---|---|---|---|
| Airflow 2.0 release blog | https://airflow.apache.org/blog/airflow-2.0/ | post | Sub-DAG break case | dedup with Pass B — already mapped |
| Airflow 3.0 release blog | https://airflow.apache.org/blog/airflow-3.0/ | post | Major-version break pattern | **ADR-015 §Research Conducted** |
| Astronomer Airflow upgrade guide | https://www.astronomer.io/docs/learn/airflow-upgrades/ | spec | Migration-cost precedent | **ADR-015 §Research Conducted** |
| `apache/airflow#9606` (Smart Sensors) | https://github.com/apache/airflow/issues/9606 | issue | Smart Sensors deprecate-within-releases | **ADR-015 §Research Conducted** |
| Airflow 2.4.0 release notes | https://airflow.apache.org/docs/apache-airflow/2.4.0/release_notes.html | spec | Smart Sensors removal | **ADR-015 §Research Conducted** |
| Airflow providers changelog | https://airflow.apache.org/docs/apache-airflow-providers/changelog.html | spec | Provider-API break precedent | drop — too broad |
| Temporal Go versioning patches blog | https://temporal.io/blog/versioning-with-patches | post | Workflow versioning precedent | **ADR-015 §Research Conducted** |
| Temporal worker versioning (legacy) | https://docs.temporal.io/dev-guide/worker-versioning-legacy | spec | Worker-version migration cost | **ADR-015 §Research Conducted** |
| Temporal worker versioning (new) | https://docs.temporal.io/workers/versioning | spec | Worker-version forward-compat | **ADR-015 §Research Conducted** |
| Dagger ending-CUE blog | https://dagger.io/blog/ending-cue-support | post | DSL replacement break (CUE→SDK) | already in ADR-015 Amendment History — redundant |
| `dagger/dagger#4086` (CUE→SDK) | https://github.com/dagger/dagger/issues/4086 | issue | DSL break detail | **ADR-015 §Research Conducted** |
| `dagger/dagger#5374` | https://github.com/dagger/dagger/issues/5374 | issue | CUE deprecation timeline | drop — issue-narrow |
| `dagger/dagger#10713` | https://github.com/dagger/dagger/issues/10713 | issue | Post-rewrite SDK feedback | drop — issue-narrow |
| Dagger 2024 highlights | https://dagger.io/blog/2024-highlights | post | Year-1 platform-engine evolution | drop — too narrow |
| Hykes HN comment (CUE retrospective) | https://news.ycombinator.com/item?id=38683004 | discussion | Founder retrospective | drop — non-authoritative |
| Dagger CHANGELOG | https://github.com/dagger/dagger/blob/main/CHANGELOG.md | spec | Breaking-change manifest | dedup with Pass A |
| n8n BREAKING-CHANGES.md | https://github.com/n8n-io/n8n/blob/master/packages/cli/BREAKING-CHANGES.md | spec | Workflow-engine break manifest | **ADR-015 §Research Conducted** |
| n8n 1.0 migration docs | https://docs.n8n.io/release-notes/1-0-migration-guide/ | spec | 1.0 break detail | **ADR-015 §Research Conducted** |
| n8n 2.0 migration docs | https://docs.n8n.io/release-notes/2-0-migration-guide/ | spec | 2.0 break detail | **ADR-015 §Research Conducted** |
| GitHub Actions HCL deprecation | https://github.blog/2019-08-08-github-actions-now-supports-ci-cd/ | post | DSL break (HCL→YAML) | **ADR-015 §Research Conducted** |
| GitHub Actions `set-output` deprecation | https://github.blog/changelog/2022-10-11-github-actions-deprecating-save-state-and-set-output-commands/ | spec | Deprecation-then-postpone pattern | **ADR-015 §Research Conducted** |
| GitHub Actions Node 16/20 migration | https://github.blog/changelog/2024-03-07-github-actions-all-actions-will-run-on-node20-instead-of-node16-by-default/ | spec | Forced-runtime-migration cost | **ADR-015 §Research Conducted** |
| GitHub Actions artifact v3 deprecation | https://github.blog/changelog/2024-04-16-deprecation-notice-v3-of-the-artifact-actions/ | spec | Artifact-API break (C-9 immutability) | **ADR-015 §Research Conducted** |
| GitHub Actions immutable actions | https://github.blog/changelog/2025-09-02-immutable-actions-are-now-generally-available/ | spec | Immutability rationale (recent) | **ADR-015 §Research Conducted** |
| CircleCI 1.0 EOL | https://circleci.com/blog/sunsetting-1-0/ | post | DSL break precedent | **ADR-015 §Research Conducted** |
| CircleCI 2.0 GA | https://circleci.com/blog/2-0-ga/ | post | 2.0 platform reset | drop — redundant with 1.0 EOL |
| Activepieces breaking changes | https://www.activepieces.com/docs/changelog | spec | Industry break-rate evidence | drop — covered by n8n+Dagger |

**Total load-bearing externals from Pass D: ~18.** Drop ~22 (issue-narrow, non-authoritative).

**Destination:** ADR-015 only.

### §1.7 — Pass E: Security Surface (`pass-e-security-surface.md`)

Pass E §8 has ~50 citations anchoring **invariants I1–I7**. CVEs are load-bearing because they materially anchor each invariant against a real exploit class:

| Citation | URL | Type | Anchors | Destination |
|---|---|---|---|---|
| OWASP CI/CD Top 10 | https://owasp.org/www-project-top-10-ci-cd-security-risks/ | spec | C-12 secrets/I1 argv-only/I3 typed-substitution | **ADR-015 §Research Conducted** |
| OWASP File Upload Cheat Sheet | https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html | spec | I6 human-upload minimums | dedup with Wave 2 + Pass H |
| n8n CVE-2025-68613 (CVSS 9.9) | https://github.com/advisories/GHSA-wfw3-33mq-9c84 | CVE | I1 argv-only — already inline in Spec-017/Plan-017 | already absorbed — redundant |
| Resecurity n8n analysis | https://www.resecurity.com/blog/article/n8n-cve-2025-68613-rce-exploit-analysis | post | CVE corpus expansion | drop — covered by NVD entry |
| Orca Security n8n analysis | https://orca.security/resources/blog/n8n-cve-2025-68613-rce-vulnerability/ | post | CVE corpus expansion | drop — covered by NVD entry |
| Airflow CVE-2024-39877 (Jinja2 RCE) | https://nvd.nist.gov/vuln/detail/CVE-2024-39877 | CVE | I3 typed-substitution — already inline in Spec-017 | already absorbed — redundant |
| Airflow CVE-2024-56373 (log template) | https://nvd.nist.gov/vuln/detail/CVE-2024-56373 | CVE | I3 — already inline in Spec-017 | already absorbed — redundant |
| Airflow CVE-2025-54550 (secret masker bypass) | https://nvd.nist.gov/vuln/detail/CVE-2025-54550 | CVE | I2 secrets-by-reference | **ADR-015 §Research Conducted** + Spec-017 §References > Security I1–I7 |
| Airflow CVE-2025-67895 (Edge3 RCE) | https://nvd.nist.gov/vuln/detail/CVE-2025-67895 | CVE | I1 argv-only | **ADR-015 §Research Conducted** + Spec-017 §References > Security I1–I7 |
| Airflow secret masker docs | https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/security/secrets/mask-sensitive-values.html | spec | I2 industry precedent | Spec-017 §References > Security I1–I7 |
| Airflow Fernet docs | https://airflow.apache.org/docs/apache-airflow/stable/administration-and-deployment/security/secrets/fernet.html | spec | I2 cipher-pin precedent | drop — broader than I2 |
| `apache/airflow#54540` (test-leak case) | https://github.com/apache/airflow/issues/54540 | issue | I2 SA-30 lessons (already inline Plan-017) | already absorbed — redundant |
| Argo CVE-2025-66626 (symlink) | https://nvd.nist.gov/vuln/detail/CVE-2025-66626 | CVE | I6 — already inline in Spec-017/Plan-017 | already absorbed — redundant |
| Argo CVE-2024-53862 | https://nvd.nist.gov/vuln/detail/CVE-2024-53862 | CVE | I6 secondary-corroboration | **ADR-015 §Research Conducted** + Spec-017 §References > Security I1–I7 |
| Argo CVE-2024-47827 | https://nvd.nist.gov/vuln/detail/CVE-2024-47827 | CVE | I4 content-addressed external refs | **ADR-015 §Research Conducted** + Spec-017 §References > Security I1–I7 |
| tj-actions CVE-2025-30066 | https://nvd.nist.gov/vuln/detail/CVE-2025-30066 | CVE | I4 supply-chain — content-addressing rationale | **ADR-015 §Research Conducted** + Spec-017 §References > Security I1–I7 |
| CISA tj-actions advisory | https://www.cisa.gov/news-events/alerts/2025/03/18/supply-chain-compromise-third-party-github-action-cve-2025-30066 | post | I4 government-attested incident | **ADR-015 §Research Conducted** |
| Wiz tj-actions analysis | https://www.wiz.io/blog/github-action-tj-actions-changed-files-supply-chain-attack-cve-2025-30066 | post | I4 corpus expansion | drop — covered by NVD/CISA |
| GitHub Security Lab — script injections | https://securitylab.github.com/research/github-actions-untrusted-input/ | post | I3 untrusted-input handling | **ADR-015 §Research Conducted** + Spec-017 §References > Security I1–I7 |
| GitHub Actions secure-use guide | https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions | spec | I3 industry minimum bar | **ADR-015 §Research Conducted** |
| GitHub Actions `pull_request_target` changelog | https://github.blog/changelog/2025-08-19-pull_request_target-trigger-now-blocked-by-default-on-forks/ | spec | I3 default-deny precedent | Spec-017 §References > Security I1–I7 |
| GitHub Actions CVE-2025-61671 | https://nvd.nist.gov/vuln/detail/CVE-2025-61671 | CVE | I3 `pull_request_target` exploit | **ADR-015 §Research Conducted** + Spec-017 §References > Security I1–I7 |
| Jenkins Script Security plugin | https://plugins.jenkins.io/script-security/ | spec | I1 sandbox precedent | **ADR-015 §Research Conducted** |
| Jenkins CVE-2024-34144 | https://nvd.nist.gov/vuln/detail/CVE-2024-34144 | CVE | I1 — already inline in `local-sqlite-schema.md` | already absorbed — redundant |
| Jenkins CVE-2024-34145 | https://nvd.nist.gov/vuln/detail/CVE-2024-34145 | CVE | I1 — already inline in `local-sqlite-schema.md` | already absorbed — redundant |
| Jenkins Pipeline Input Step | https://www.jenkins.io/doc/pipeline/steps/pipeline-input-step/ | spec | Approval-gate input precedent (C-13 historical) | drop — covered by GitHub Actions |
| Temporal Data Encryption | https://docs.temporal.io/security#encryption-in-transit | spec | C-12 secrets-by-reference | **ADR-015 §Research Conducted** |
| Temporal idempotent signals | https://docs.temporal.io/develop/typescript/message-passing#signal-handlers | spec | C-9 idempotency | drop — covered by Pass A Temporal SDK |
| Langflow CVE-2025-3248 | https://nvd.nist.gov/vuln/detail/CVE-2025-3248 | CVE | I1 untrusted-code-eval | **ADR-015 §Research Conducted** + Spec-017 §References > Security I1–I7 |
| Langflow CVE-2025-34291 | https://nvd.nist.gov/vuln/detail/CVE-2025-34291 | CVE | I1 — corpus expansion | Spec-017 §References > Security I1–I7 |
| Prefect CVE-2024-8183 | https://nvd.nist.gov/vuln/detail/CVE-2024-8183 | CVE | I3 input-injection | **ADR-015 §Research Conducted** + Spec-017 §References > Security I1–I7 |
| CircleCI 2023 incident | https://circleci.com/blog/january-4-2023-security-alert/ | post | I2 secrets-incident severity | **ADR-015 §Research Conducted** |

**Total load-bearing externals from Pass E: ~22** (already-absorbed CVEs counted as redundant). Drop ~28 (vendor-blog rehashes of NVD entries, narrow security guides).

**Destination:** ADR-015 only.

### §1.8 — Pass F: Event Taxonomy (`pass-f-event-taxonomy.md`)

Pass F §6 has 10 numbered primary sources. **All 10 are load-bearing** (every event-taxonomy decision anchored to one of them):

| Citation | URL | Type | Anchors | Destination |
|---|---|---|---|---|
| CloudEvents v1.0.2 spec | https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md | spec | SA-18 envelope additive bump | dedup with Wave 2 — already mapped |
| CloudEvents documented extensions | https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/documented-extensions.md | spec | SA-18 extension-additivity rule | already in Spec-017 — redundant |
| CloudEvents subject field GitHub #112 | https://github.com/cloudevents/spec/issues/112 | issue | SA-18 subject-field rationale | drop — issue-narrow |
| OpenTelemetry Semantic Conventions for Events | https://github.com/open-telemetry/semantic-conventions/blob/main/docs/general/events.md | spec | SA-19 event-name convention | dedup with Wave 2 — already mapped |
| OpenTelemetry GenAI observability blog (2025) | https://opentelemetry.io/blog/2025/genai-observability/ | post | SA-19 LLM-event semantic convention | Plan-017 §References |
| Temporal events | https://docs.temporal.io/develop/typescript/observability/events | spec | SA-20 reserved-event list | dedup with Wave 2 — already mapped |
| Temporal events reference | https://docs.temporal.io/references/events | spec | SA-20 reserved-event list | dedup with Wave 2 — already mapped |
| Temporal encyclopedia (events) | https://temporal.io/blog/temporal-encyclopedia-events | post | SA-20 industry-precedent | drop — covered by primary spec |
| Argo workflow events | https://argo-workflows.readthedocs.io/en/latest/architecture/#workflow-engine | spec | Pass F §3 architecture comparison | Plan-017 §References |
| n8n executions API | https://docs.n8n.io/api/api-reference/#tag/Execution | spec | Pass F §3 industry comparison | Plan-017 §References |

**Total load-bearing externals from Pass F: ~5** (5 already covered by Wave 2 / Spec-017).

**Destination:** Plan-017 only.

### §1.9 — Pass G: Persistence Model (`pass-g-persistence-model.md`)

Pass G §9 has 9 numbered citations anchoring the 9-table schema + hash-chain verification scheme. **Critical: this Pass dual-targets `local-sqlite-schema.md` because the 9-table schema lives there.**

| Citation | URL | Type | Anchors | Destination |
|---|---|---|---|---|
| Temporal events (custom persistence blog 2024) | https://temporal.io/blog/custom-persistence-2024 | post | Persistence-model precedent | Plan-017 §References + `local-sqlite-schema.md §Workflow Tables` introduction |
| Temporal events reference | https://docs.temporal.io/references/events | spec | dedup with Pass F | already mapped |
| Restate building modern durable execution (2025) | https://restate.dev/blog/building-modern-durable-execution/ | post | Per-run hash-chain rationale (C-13) | Plan-017 §References + `local-sqlite-schema.md §Workflow Tables` |
| SQLite WAL | https://www.sqlite.org/wal.html | spec | dedup with Wave 2 / Spec-015 | already absorbed — redundant |
| SQLite JSON1 | https://www.sqlite.org/json1.html | spec | JSON-column rationale (workflow_definitions) | `local-sqlite-schema.md §Workflow Tables` |
| Crosby & Wallach 2009 (USENIX) | https://www.usenix.org/legacy/event/sec09/tech/full_papers/crosby.pdf | paper | C-13 hash-chain | dedup with Wave 2 — already mapped |
| AuditableLLM (MDPI 2025) | https://www.mdpi.com/2079-9292/14/10/2059 | paper | C-13 LLM audit-log precedent | dedup with Wave 2 — already mapped |
| Google Trillian | https://github.com/google/trillian | code | C-13 operational precedent | dedup with Wave 2 — already mapped |
| Argo persistence/archiving | https://argo-workflows.readthedocs.io/en/latest/workflow-archive/ | spec | Persistence-tier precedent | Plan-017 §References + `local-sqlite-schema.md §Workflow Tables` |
| Argo offloading-large-workflows | https://argo-workflows.readthedocs.io/en/latest/offloading-large-workflows/ | spec | Large-workflow persistence pattern | Plan-017 §References |
| Cadence persistence docs | https://cadenceworkflow.io/docs/concepts/cross-dc-replication/ | spec | Persistence-tier industry comparison | Plan-017 §References |
| `better-sqlite3` v12.9.0 (2026-04-12) | https://github.com/WiseLibs/better-sqlite3 | code | dedup with Spec-015 | already absorbed — redundant |

**Total load-bearing externals from Pass G: ~7** (5 already absorbed elsewhere).

**Destination:** Plan-017 + `local-sqlite-schema.md` (dual).

### §1.10 — Pass H: Testing Strategy (`pass-h-testing-strategy.md`)

Pass H §9 has 10 numbered citations anchoring 5 test categories (SA-29 = property/fuzz/load/integration/security-regression). All 10 directly support test-category decisions:

| Citation | URL | Type | Anchors | Destination |
|---|---|---|---|---|
| fast-check (model-based testing) | https://github.com/dubzzz/fast-check | code | dedup with Wave 2 | already mapped |
| Jazzer.js | https://github.com/CodeIntelligenceTesting/jazzer.js | code | dedup with Wave 2 | already mapped |
| Jazzer.js fuzz-targets docs | https://github.com/CodeIntelligenceTesting/jazzer.js/blob/main/docs/fuzz-targets.md | spec | SA-29 fuzz-target shape | Plan-017 §References |
| GitHub Actions script-injection guidance | https://securitylab.github.com/research/github-actions-untrusted-input/ | post | dedup with Pass E | already mapped |
| `apache/airflow#54540` (test-leak) | https://github.com/apache/airflow/issues/54540 | issue | dedup with Pass E | already absorbed |
| Temporal TypeScript SDK testing suite | https://docs.temporal.io/develop/typescript/testing-suite | spec | `runReplayHistory` contract — already inline Plan-017 SA-31 | already absorbed — redundant |
| OWASP File Upload Cheat Sheet | https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html | spec | dedup with Wave 2 / Pass E | already mapped |
| Endor Labs CVE-2025-66626 analysis | https://www.endorlabs.com/learn/cve-2025-66626-argo-workflows | post | Argo broken-fix precedent | Plan-017 §References |
| Astronomer testing Airflow | https://www.astronomer.io/docs/learn/testing-airflow/ | spec | DAG-test precedent | Plan-017 §References |
| Bitovi replay testing blog | https://www.bitovi.com/blog/replay-testing-temporal-workflows | post | SA-31 replay-test pattern | Plan-017 §References |
| n8n CVE-2025-68613 advisory | https://github.com/advisories/GHSA-wfw3-33mq-9c84 | CVE | dedup with Pass E | already absorbed |

**Total load-bearing externals from Pass H: ~5 unique** (5 already absorbed).

**Destination:** Plan-017 only.

---

## §2 — Absorption Confirmed Matrix (Pass × Destination)

Verdict legend: **A** = already absorbed (no T14-T18 work needed); **P** = partially absorbed (some citations in destination, others still needed); **N** = not yet absorbed; **n/a** = Pass does not target that destination.

| Pass | ADR-015 §Research Conducted (new table) | Spec-017 §References | Plan-017 §References (new) | `local-sqlite-schema.md` |
|---|---|---|---|---|
| Wave 1 synthesis | n/a (zero unique externals) | n/a | n/a | n/a |
| Wave 2 synthesis | **N** — full table to add | **A** (lines 419–475 carry SA-18…SA-31 sources) | n/a | **A** (line 11 covers `synchronous=FULL`) |
| Pass A — Parallel | **N** — needs Airflow DAG/Pools, Astronomer trigger rules, Argo parallelism, Step Functions error-handling, Dagster concurrency, `apache/airflow#4322`, `argoproj/argo-workflows#11984`/`#740`, `temporalio/sdk-java#902`, `PrefectHQ/prefect#17867` | **P** — Temporal SDK + Argo suspending already absorbed; Airflow Pools + Step Functions error-handling + Dagster concurrency NOT yet | n/a | n/a |
| Pass B — Channel contract | **N** — needs Temporal ParentClosePolicy, Airflow 2.0 + `#1350` + Twine Labs + Astronomer 2.0 guide, n8n executeWorkflow, Activepieces SubFlows, Argo `#12425`, Step Functions best practices, Dapr workflow patterns | n/a | n/a | n/a |
| Pass C — Human phase UX | n/a | **P** — Camunda 8 user tasks + GitHub Actions reviewing deployments + Argo intermediate-parameters NOT yet; W3C WCAG 2.2 §3.3.7 + MCP elicitations NOT yet | **N** — entire C-list to add (no References section yet in Plan-017) | n/a |
| Pass D — Freeze regrets | **N** — Airflow 3.0 + Astronomer upgrade + `apache/airflow#9606` + Airflow 2.4.0 release notes + Temporal Go versioning + Temporal worker versioning (legacy + new) + n8n BREAKING-CHANGES + n8n 1.0/2.0 migration + GH Actions HCL deprecation + `set-output` + Node 16/20 migration + artifact v3 deprecation + immutable actions + CircleCI 1.0 EOL + `dagger/dagger#4086` | n/a | n/a | n/a |
| Pass E — Security | **N** — needs OWASP CI/CD Top 10, Airflow CVE-2025-54550 + CVE-2025-67895 + secret masker, Argo CVE-2024-53862 + CVE-2024-47827, tj-actions CVE-2025-30066 + CISA, GH Security Lab script-injection + secure-use, GH Actions `pull_request_target` + CVE-2025-61671, Jenkins Script Security, Temporal Data Encryption, Langflow CVE-2025-3248, Prefect CVE-2024-8183, CircleCI 2023 incident | **P** — n8n CVE-2025-68613 + Airflow CVE-2024-39877/56373 + Argo CVE-2025-66626 + Jenkins CVE-2024-34144/34145 already inline; OWASP CI/CD Top 10 + Langflow + Prefect + GH Security Lab NOT yet | n/a | n/a |
| Pass F — Event taxonomy | n/a | **A** — CloudEvents v1.0.2 + OpenTelemetry semconv + Temporal events all in Spec-017 §References | **N** — OpenTelemetry GenAI observability + Argo workflow events + n8n executions need landing | n/a |
| Pass G — Persistence | n/a | **A** (line 11 + §References cover Crosby & Wallach + better-sqlite3) | **N** — Restate durable execution + Argo persistence/archiving + offloading-large-workflows + Cadence persistence + Temporal custom persistence + SQLite JSON1 need landing | **N** — `local-sqlite-schema.md §Workflow Tables` introduction (line 389) needs Restate + Argo persistence/archiving + Cadence persistence inserted; lines 681 + 683 currently link `pass-g-persistence-model.md` and become dead links on deletion |
| Pass H — Testing | n/a | n/a | **N** — Jazzer.js fuzz-targets + Endor Labs CVE-2025-66626 + Astronomer testing Airflow + Bitovi replay-testing need landing in Plan-017 (no References section exists yet) | n/a |

**Worklist density** (Not-Yet cells):
- ADR-015 §Research Conducted [new table]: 6 Pass groups (Wave 2 + A + B + D + E)
- Spec-017 §References (deltas only): 2 Pass groups (Pass C deltas + Pass E deltas — most already absorbed)
- Plan-017 §References [new section]: 4 Pass groups (Pass C + F + G + H)
- `local-sqlite-schema.md` §Workflow Tables: 1 Pass group (Pass G — both intro line 389 and dead-link replacements at 681/683)

---

## §3 — Unique-Content Risk

### §3.1 — Class A (Orphan citations — lost on deletion if not landed)

The §1 destination map enumerates ~80 distinct external citations across the 10 research files (after dedup). Of those, **~50** are not currently in any destination doc. These are the orphans T14–T18 must land. The highest-risk subset (load-bearing for a contract commitment, security invariant, or schema decision):

1. **Pass D (full-engine-at-V1 thesis evidence)** — Airflow 3.0 release blog, `apache/airflow#9606` (Smart Sensors), Temporal worker versioning new + legacy, n8n BREAKING-CHANGES.md + 1.0 + 2.0 migration guides, GitHub Actions `set-output` deprecation + Node 16/20 + artifact v3 deprecation + immutable actions, CircleCI 1.0 EOL. **Without these in ADR-015 §Research Conducted, the rationale for "full engine at V1" loses its primary-source evidence base** — every "every surveyed system shipped a V1 subset and broke later" claim becomes unsupported. **CRITICAL.**
2. **Pass E (security invariant CVE corpora)** — Airflow CVE-2025-54550 (I2), CVE-2025-67895 (I1), Argo CVE-2024-53862 (I6) + CVE-2024-47827 (I4), tj-actions CVE-2025-30066 + CISA (I4), GitHub Actions CVE-2025-61671 (I3), Langflow CVE-2025-3248 (I1), Prefect CVE-2024-8183 (I3), CircleCI 2023 incident (I2). **Each anchors a specific I1–I7 invariant; deletion = invariants lose proof-of-need.** **CRITICAL.**
3. **Pass G persistence-pattern primaries** — Restate durable execution 2025, Argo persistence/archiving + offloading-large-workflows, Cadence persistence, SQLite JSON1, Temporal custom persistence 2024 blog. **Without these, the 9-table schema's design decisions lose external precedent.** **CRITICAL for `local-sqlite-schema.md` §Workflow Tables.**
4. **Pass A scheduling primaries** — Airflow DAG source + Pools, Astronomer trigger rules, Step Functions error handling, Dagster concurrency. Anchor C-3 (DAG executor) + SA-3 (resource pools) + SA-4 (ParallelJoinPolicy `fail-fast`). **Important** — without these, SA-1/3/4 lose precedent.
5. **Pass B BIND-criterion evidence** — Temporal ParentClosePolicy, Airflow `#1350` SubDAG removal, Twine Labs deadlock writeup, Astronomer 2.0 upgrade guide. **Important** — these are the specific citations behind ADR-015 §V1.1 Criterion-Gated Commitments (BIND criterion (b) "concrete failure case documented").

### §3.2 — Class B (Broken internal links — destination docs currently point at research/)

Per `Grep "research/bl-097-workflow-scope/"`, the following destination files contain links that **become dead on research/ deletion** unless replaced:

| File | Line(s) | Target | Replacement strategy for T14–T18 |
|---|---|---|---|
| `docs/decisions/015-v1-feature-scope-definition.md` | 56, 68, 76, 149, 176, 178–187, 234 | wave-1, wave-2, pass-a..h | Replace `BL-097 Research Provenance` list (lines 176–187) with the new `### Research Conducted` table; spot-replace inline pointers at 56/68/76/149/234 with the primary-source citations from §1 above |
| `docs/specs/017-workflow-authoring-and-execution.md` | 146, 376, 377, 393–402 | pass-b §3.1, wave-2, all 10 research files | Replace `BL-097 research provenance` block (lines 393–402) with primary-source citations grouped by topic (already mostly done — finish Pass C + Pass E deltas); rewrite line 146 to cite Temporal ParentClosePolicy + Pass B inline; rewrite lines 376, 377 to point at primary sources |
| `docs/plans/017-workflow-authoring-and-execution.md` | 9, 15, 61, 67, 90, 102 | wave-2, pass-c, pass-f, pass-g, pass-h | Replace inline research-pointer wording with primary-source citations; create new `## References` section at end-of-file (Plan-024 pattern) absorbing Pass C/F/G/H load-bearing externals |
| `docs/architecture/schemas/local-sqlite-schema.md` | 389, 681, 683 | pass-g §2, §3, §5 | Line 389: keep prose, replace pointer with new `## References` line at end of `§Workflow Tables` listing Restate/Argo/Cadence/Crosby & Wallach/Trillian. Lines 681 + 683: replace `[Pass G §3]` and `[Pass G §5]` with primary-source citations (Restate + Argo persistence/archiving + Cadence + Crosby & Wallach hash-chain). |
| `docs/backlog.md` | 732 | wave-1, wave-2, pass-a..h | This is the BL-097 Resolution entry itself. Two valid handlings: (a) replace each research-pointer inline with the primary source it backs (preferred — preserves Resolution rationale citation density), or (b) leave the BL-097 Resolution as-is and treat backlog.md historical resolutions as exempt from research/ deletion fallout (matches how ADR Decision-Log entries are typically frozen). **T14-T18 should pick one before merging.** |

The `docs/audit/session-h-final-h2-findings/lane-c-internal-cross-reference-validity.md` line 65 already documented that anchors *inside* research files were not audited; that audit artifact is itself a historical record that can stay as-is (its purpose is to document the audit done at that point in time).

### §3.3 — Anomalies / Risks Surfaced

1. **ADR-015 has no `### Research Conducted` table** — pre-T14 amendment landed only a flat `BL-097 Research Provenance` list (lines 176–187) plus inline citations in the Amendment History prose. T14 must **create** the table from scratch, using ADR-016 lines 151–178 / ADR-017 lines 111–137 as format precedent. This is the largest single block of new work in T14.

2. **Plan-017 has no `## References` section at end-of-file** — the Plan-024 flat-list pattern is the precedent. T16-T18 must create one. Plan-017's existing inline-CVE-link approach (Test table) is *complementary* to a flat References list, not a substitute for it.

3. **Cross-Pass duplication with Wave 2** — Crosby & Wallach + AuditableLLM + Trillian + OWASP File Upload + CloudEvents + OpenTelemetry semconv all appear in both Wave 2 §7 and the individual Pass that originated them (E, F, G, or H). **T14 should cite each source once in ADR-015 with the broadest-applicable Pass tagged**, not duplicate.

4. **Cross-Pass duplication of NVD CVE entries** — many CVEs cited in Pass E §8 are also independently cited in Pass H §9 (testing-strategy lessons learned). T16-T18 should cite each CVE **once** in the destination doc and let the multi-Pass anchor be implicit.

5. **`docs/backlog.md` line 732 (BL-097 Resolution entry) is itself research-link-dense** — it's the BL Resolution prose and contains 9+ pointers into research/. The cleanup architectural choice (a vs b in §3.2) is non-trivial because backlog Resolution entries are normally meant to be frozen historical records. **Recommend T14 escalate this decision before T15-T18 begin.**

6. **`docs/audit/session-h-final-h5-remediation-plan.md` lines 260, 1135, 1141** — these point at `wave-1-synthesis.md:87` and similar deep anchors. They're audit artifacts; recommend keeping as-is (research/ deletion risk is acknowledged in the audit lane-c finding at line 65).

7. **Wave 1 contributes zero unique externals** — Wave 1 is purely synthesis prose with all primary citations re-cited in the underlying Pass A–E files. The new ADR-015 §Research Conducted table replaces Wave 1's role as a citation-anchor surface; Wave 1 itself is then safely deletable as long as the Pass A–E primary citations are landed.

8. **One high-stakes unverified link** — `apache/airflow#54540` is cited in both Pass E and Pass H. Already inline in `local-sqlite-schema.md`. Confirm this remains a live GitHub issue at landing time (audit lane-b — citation-quote-fidelity may already cover this).

9. **Class B finding density per destination** — ADR-015 has ~14 broken-link sites; Spec-017 has ~10; Plan-017 has ~6; `local-sqlite-schema.md` has 3; `backlog.md` has 1 (very dense). Total: ~34 sites needing surgical replacement (vs ~50 orphan citations needing landing). **Class A and Class B are roughly equivalent in workload.**

---

## §4 — Closure

**Section-level destination-mapped citation list ready for T14 (ADR-015), T15 (Spec-017), T16 (Plan-017), T17 (Plan-017 References create), T18 (`local-sqlite-schema.md`).**

Total embed-worthy unique externals across 10 source files: **~80** (after Wave 1/Wave 2/Pass-internal dedup). Of those:
- **~30** already absorbed in some destination — verify present, do not re-cite.
- **~50** orphans — must be landed before research/ deletion.
- **~34** broken-link replacement sites distributed across 5 destination files (counting backlog.md).

**Recommended landing order for T14–T18:**
1. T14 — ADR-015 §Research Conducted table (largest single new block; consolidates Wave 2 + A + B + D + E).
2. T15 — Spec-017 §References Pass C + Pass E delta additions.
3. T16 — Plan-017 inline-pointer rewrites (lines 9/15/61/67/90/102).
4. T17 — Plan-017 new `## References` section absorbing Pass C/F/G/H.
5. T18 — `local-sqlite-schema.md` line 389 prose + lines 681/683 replacement + new `§Workflow Tables` References block.

Plus: T14-prerequisite escalation decision on `docs/backlog.md` line 732 (Class B-vs-(a)/(b) policy choice for BL Resolution entries).
