# Workflow Sources

The external primary sources behind [Spec-015: Workflow Authoring And Execution](../specs/015-workflow-authoring-and-execution.md) and [Plan-014: Workflow Authoring And Execution](../plans/014-workflow-authoring-and-execution.md), and the documents Plan-014 rests on.

**DSL / schema-version / freeze-regret precedents (C-1, C-6, C-8, C-9, C-11, C-12, SA-14, SA-15, SA-16, SA-17):**

- [Dagger — Ending Support for the Dagger CUE SDK](https://dagger.io/blog/ending-cue-support/) — 2023
- [Changelog #550 — From Docker to Dagger with Solomon Hykes](https://changelog.com/podcast/550) — 2023
- [GitHub Actions — HCL→YAML deprecation](https://github.blog/changelog/2019-09-17-github-actions-will-stop-running-workflows-written-in-hcl/) — 2019
- [Airflow 2.0 provider packages](https://airflow.apache.org/docs/apache-airflow-providers/) — forced split from `airflow.contrib`
- [Airflow — Turn off pickling of XCom by default in 2.0, #9606](https://github.com/apache/airflow/issues/9606) — JSON replaced Pickle to close RCE exposure; `[core] enable_xcom_pickling` forced to `False`
- [Airflow — Upgrading to Airflow 3](https://airflow.apache.org/docs/apache-airflow/stable/installation/upgrading_to_airflow3.html) — Datasets→Assets, SubDAG→TaskGroup, execution_date→logical_date
- [Airflow — Deprecate SubDags in Favor of TaskGroups, #12292](https://github.com/apache/airflow/issues/12292) — SubDAG removed in Airflow 3.0; TaskGroup is the canonical replacement
- [GitHub Actions — v3 artifact deprecation notice (2024-04-16)](https://github.blog/changelog/2024-04-16-deprecation-notice-v3-of-the-artifact-actions/) — mutability-forced v3→v4 migration precedent for C-9 / SA-16

**Security invariants (I1–I5, C-15, C-16):**

- [GitHub Actions — Script-injection guidance](https://docs.github.com/en/actions/concepts/security/script-injections)
- [n8n CVE-2025-68613 advisory (CVSS 9.9)](https://github.com/n8n-io/n8n/security/advisories/GHSA-v98v-ff95-f3cp)
- [Airflow CVE-2024-39877](https://nvd.nist.gov/vuln/detail/CVE-2024-39877)
- [tj-actions/changed-files CVE-2025-30066](https://nvd.nist.gov/vuln/detail/CVE-2025-30066)
- [Airflow secret masker issue #54540 (Vault masking regression, Airflow 3.0.0-3.0.4)](https://github.com/apache/airflow/issues/54540)
- [Jenkins SECURITY-576 / CVE-2017-1000108 advisory (2017-08-07)](https://www.jenkins.io/security/advisory/2017-08-07/)
- [NVD CVE-2017-1000108 — Pipeline Input Step Item/Read → Item/Build](https://nvd.nist.gov/vuln/detail/CVE-2017-1000108)
- [Pipeline Input Step source — `canSettle()` admin bypass](https://github.com/jenkinsci/pipeline-input-step-plugin/blob/master/src/main/java/org/jenkinsci/plugins/workflow/support/steps/input/InputStepExecution.java)
- [JENKI16 — submitterParameter ignored for admins (Won't Fix)](https://issues.jenkins.io/browse/JENKI16)

**Execution semantics + human step (D1, D2, SA-1…SA-12, SA-26):**

- [Temporal — Workflow Execution Timeouts](https://docs.temporal.io/encyclopedia/detecting-workflow-failures)
- [Temporal — Child Workflows (TypeScript)](https://docs.temporal.io/develop/typescript/child-workflows)
- [Argo — Suspending Workflows walkthrough](https://argo-workflows.readthedocs.io/en/latest/walk-through/suspending/)
- [Argo — Intermediate Parameters](https://argo-workflows.readthedocs.io/en/latest/intermediate-inputs/) — human-step form-input pattern (SA-10)
- [AWS Step Functions — Error handling](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html) — error-handling precedent for a run that ends failed canceling its running siblings (SA-4)
- [Camunda 8 — User tasks](https://docs.camunda.io/docs/components/modeler/bpmn/user-tasks/) — assignments, scheduling, dueDate, followUpDate; human-step claim-semantics precedent
- [GitHub Actions — Reviewing deployments](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments) — approval UX precedent for the `human.approval` step (SA-12)
- [LangGraph — Multi-agent handoff](https://langchain-ai.github.io/langgraph/concepts/multi_agent/)
- [AutoGen — Teams and HandoffMessage](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html)
- [OpenAI Assistants API — Migration / Threads removal 2026-08-26](https://platform.openai.com/docs/assistants/migration)
- [Model Context Protocol — Elicitations](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation) — an elicitation is a `question.asked` record, never an approval category
- [W3C WCAG 2.2 §3.3.7 — Redundant Entry](https://www.w3.org/TR/WCAG22/#redundant-entry) — human-step form-state UX requirement (SA-26)
- [Argo Workflows — `suspend-template-outputs.yaml` example](https://github.com/argoproj/argo-workflows/blob/main/examples/suspend-template-outputs.yaml) — output-projection-on-resume pattern
- [argoproj/argo-workflows#8365](https://github.com/argoproj/argo-workflows/discussions/8365) — form-input UX gap (Argo discussion)
- [Camunda 8 — handling data in processes](https://docs.camunda.io/docs/components/best-practices/development/handling-data-in-processes/) — form-data persistence pattern
- [AWS Step Functions — human-approval tutorial](https://docs.aws.amazon.com/step-functions/latest/dg/sample-project-human-approval.html) — approval-step sample
- [AWS Step Functions — `SendTaskHeartbeat`](https://docs.aws.amazon.com/step-functions/latest/apireference/API_SendTaskHeartbeat.html) — heartbeat-based liveness pattern
- [Temporal — Python message passing](https://docs.temporal.io/develop/python/message-passing) — signal-based human input
- [Temporal — automation of human-in-the-loop workflows](https://pages.temporal.io/webinar-automation-of-human-in-the-loop-workflows-with-temporal.html) — HITL workflow pattern
- [LangGraph — human-in-the-loop](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/) — HITL primitive (LLM stack)
- [Microsoft Agent Framework — AG-UI HITL](https://learn.microsoft.com/en-us/agent-framework/integrations/ag-ui/human-in-the-loop) — HITL primitive (recent industry)

**Event taxonomy (SA-18…SA-22):**

- [CloudEvents Specification v1.0.2](https://github.com/cloudevents/spec/blob/v1.0.2/cloudevents/spec.md) — envelope additive-bump rules (SA-18)
- [Temporal — Events and Event History](https://docs.temporal.io/workflow-execution/event)
- [Temporal Events Reference](https://docs.temporal.io/references/events)
- [Temporal Encyclopedia — Event History](https://docs.temporal.io/encyclopedia/event-history)
- [OpenTelemetry Semantic Conventions for Events](https://opentelemetry.io/docs/specs/semconv/general/events/) — event-name convention precedent (SA-19)
- [n8n Workflow Executions Docs](https://docs.n8n.io/workflows/executions/)
- [OpenTelemetry AI Agent observability blog (2025)](https://opentelemetry.io/blog/2025/ai-agent-observability/) — LLM-event semantic-convention rationale (SA-19)
- [Argo Workflows architecture — workflow events](https://argo-workflows.readthedocs.io/en/latest/architecture/#workflow-engine) — event-engine industry comparison
- [n8n executions API reference](https://docs.n8n.io/api/api-reference/#tag/Execution) — execution-event industry comparison

**Persistence (SA-24, SA-25, SA-26):**

- [SQLite — Write-Ahead Logging](https://www.sqlite.org/wal.html)
- [Temporal blog — Custom persistence layer](https://temporal.io/blog/higher-throughput-and-lower-latency-temporal-clouds-custom-persistence-layer) — 2024; persistence-model precedent
- [Argo Workflows — Offloading Large Workflows](https://argo-workflows.readthedocs.io/en/latest/offloading-large-workflows/) — large-workflow persistence pattern
- [Restate — What is Durable Execution](https://restate.dev/what-is-durable-execution) — per-invocation durable-log precedent (C-13)
- [Argo Workflows — workflow archive](https://argo-workflows.readthedocs.io/en/latest/workflow-archive/) — persistence-tier precedent
- [Cadence — cross-DC replication / persistence](https://cadenceworkflow.io/docs/concepts/cross-dc-replication) — persistence-tier industry comparison
- [SQLite — JSON1 extension](https://www.sqlite.org/json1.html) — JSON-column rationale for `workflow_definitions`

**Canvas and expression libraries ([Spec-015 §Visual Workflow Builder](../specs/015-workflow-authoring-and-execution.md#visual-workflow-builder), [Spec-015 §Expressions](../specs/015-workflow-authoring-and-execution.md#expressions), [Workflow Implementation Notes](workflow-implementation-notes.md)):**

- [React Flow component reference — controlled mode and props](https://reactflow.dev/api-reference/react-flow) (read 2026-09-09)
- [React Flow TypeScript guide — typed node generics](https://reactflow.dev/learn/advanced-use/typescript) (read 2026-09-09)
- [React Flow — updating a node's internals](https://reactflow.dev/api-reference/hooks/use-update-node-internals) (read 2026-09-09) — the hook a kind whose handle set depends on its params calls after a param write
- [React Flow — node toolbar example](https://reactflow.dev/examples/nodes/node-toolbar) (read 2026-09-09)
- [React Flow — drag-and-drop example](https://reactflow.dev/examples/interaction/drag-and-drop) (read 2026-09-09)
- [React Flow — layered layout example](https://reactflow.dev/examples/layout/dagre) (read 2026-09-09)
- [React Flow](https://reactflow.dev/) (read 2026-06-03 and 2026-09-09) — the library scan that chose it over the runner-up, whose round-trip finding Spec-015 keeps: a canvas is a projection over the stored model and never a competing source of truth
- [JSONata](https://jsonata.org) (read 2026-09-09)

Two adopted packages carry no documentation page in any source read for Spec-015 — the WebAssembly interpreter behind the Code node and the scheduling library behind the schedule trigger. Their pins, licenses and sizes were read from the npm registry on 2026-09-21 and are recorded in [Workflow Implementation Notes](workflow-implementation-notes.md) rather than asserted from a page.

**Code tiers, the sandbox boundary, and memory-gated admission (SA-3, I2):**

- [Anthropic sandbox runtime](https://github.com/anthropics/sandbox-runtime) (read 2026-09-21) — the reusable wrapper a full-tier Code node and a `developer.shell` node are spawned under on the Claude leg: Seatbelt on macOS, bubblewrap on Linux, a dedicated local account with an egress fence on Windows, network default-deny through a local proxy. Its own banner calls it an early research preview whose interfaces may still move.
- `codex sandbox --help` on codex-cli 0.155.1 (read 2026-09-21) — the Codex-leg wrapper, `codex sandbox [OPTIONS] [COMMAND]...` with `-P / --permission-profile <NAME>`. How each posture maps onto a provider's own sandbox and network settings is [Spec-010 §Required Behavior](../specs/010-approvals-permissions-and-trust-boundaries.md#required-behavior)'s, not restated here.
- [Node — `process.availableMemory()`](https://nodejs.org/docs/latest-v24.x/api/process.html#processavailablememory) — the call the admission gate re-reads each tick. From Node 24.16.0 it sums free, inactive and purgeable pages on macOS; on Node 22 it returns free pages alone, the same number as `os.freemem()`, which is why the daemon and the CLI need Node 24.16 or later; the workspace's one Node line is 24.21.
- Measured on an Apple-silicon Mac, 2026-09-21: a TypeScript program naming its package in its import line and a Python program naming its packages in its own inline metadata block each ran with their packages inside `codex sandbox` on the workspace profile, with home-directory writes and the network blocked, and the sandbox cost about 0.02 s per run. Linux and Windows are unmeasured.
- Measured on macOS and on Linux (Debian 12 in a container): the lock, install and run of a full-tier Code step under both providers' sandboxes and with no sandbox, the writes each allows, and clearing each package cache — installed steps kept running, a later run fetched nothing, and the other cache and the managed Python were untouched. Windows is unmeasured, and so is either sandbox started by the daemon on an Ubuntu 24.04 desktop.
- [uv — Running scripts, §Locking dependencies](https://docs.astral.sh/uv/guides/scripts/#locking-dependencies) — inline script metadata and `uv lock --script`, which writes the lock beside the script.
- [Bun — `bun install`](https://bun.com/docs/cli/install) — `--lockfile-only` writes the lock without installing, and `--frozen-lockfile` installs the locked versions and exits with an error where the manifest disagrees with the lock.
- [Claude Code — Sandboxing](https://docs.claude.com/en/docs/claude-code/sandboxing) and [Codex — Agent approvals and security](https://developers.openai.com/codex/agent-approvals-security) — the two providers' own sandbox documentation, whose settings the full tier and `developer.shell` are run under.
- [RE2JS](https://github.com/le0pard/re2js) — a JavaScript port of RE2, MIT, matching in time linear in its input; the expression engine's regular expressions run on it ([Spec-015 §Expressions](../specs/015-workflow-authoring-and-execution.md#expressions)).

**Chat-command interception and authorization precedents (SA-35, SA-36, C-18):**

- [Discord — Application Commands](https://discord.com/developers/docs/interactions/application-commands) — registered, typed, autocompleted, per-command-permission commands; platform-owned interception (accessed 2026-08-11)
- [Slack — Slash commands](https://api.slack.com/interactivity/slash-commands) — command payloads delivered to the app, never echoed as channel text (accessed 2026-08-11)

**Park, pacing, and durable resumption precedents (SA-37, SA-38, SA-39, SA-40, C-19):**

- [Cloudflare Workflows — events and parameters (`waitForEvent`)](https://developers.cloudflare.com/workflows/build/events-and-parameters/) — durable wait primitive whose pending state is persisted rather than held in process memory (SA-37's durable-row-not-in-memory-timeout rule)
- [n8n Workflow Executions](https://docs.n8n.io/workflows/executions/) — durable-resume prior art, already cited above for `workflow.resumed` cadence and reused here for the resume-from-persisted-state shape

**Testing (SA-27):**

- [`fast-check` (model-based testing)](https://github.com/dubzzz/fast-check) — property-test framework pin (SA-27)
- [Jazzer.js (fuzzing)](https://github.com/CodeIntelligenceTesting/jazzer.js) — fuzz-test framework pin (SA-27)
- [Jazzer.js — fuzz-targets docs](https://github.com/CodeIntelligenceTesting/jazzer.js/blob/main/docs/fuzz-targets.md) — fuzz-target shape (SA-27)
- [Astronomer — testing Airflow](https://www.astronomer.io/docs/learn/testing-airflow/) — DAG-test precedent

**Documents Plan-014 rests on:**

- [Spec-015: Workflow Authoring And Execution](../specs/015-workflow-authoring-and-execution.md) — paired spec; canonical SA narrative
- [Workflow Verification](./workflow-verification.md) — what each test layer proves, the two workflows, the screen states and the done list
- [ADR-014: V1 Feature Scope Definition](../decisions/014-v1-feature-scope-definition.md) — the V1 feature set, which ships the whole workflow engine with the human step's `Timeout` and every data act, and defers one feature outside it; §Research Conducted (primary-source corpus)
- [ADR-012: Cedar Approval Policy Engine](../decisions/012-cedar-approval-policy-engine.md) — the `human.approval` evaluation path (I-014-3)
- [ADR-016: Shared Event-Sourcing Scope](../decisions/016-shared-event-sourcing-scope.md) — the locally-authoritative `session_events` log the `workflow.*` event types ride (I-014-5)
- [ADR-024: Visual Node-Graph Workflow Authoring](../decisions/024-visual-node-graph-workflow-authoring.md) — the node-graph authoring decision governing T1.7 / T5.4 / T5.5 / T5.6 and I-014-10…I-014-12
- [ADR-025: Chat-Invoked Workflow Start and Start Authorization](../decisions/025-chat-invoked-workflow-start.md) — the chat-start and start-authorization decision governing T5.7 / T5.8 / T5.9 and I-014-13…I-014-14
- [ADR-036: Workflow Secrets in the OS Keychain](../decisions/036-workflow-secrets-in-the-os-keychain.md) — the keychain custody T1.11 builds and T2.2 resolves from (I-014-4)
- [Workflow Tables (Plan-014)](./schemas/local-sqlite-workflow-tables.md) — the workflow schema and write-amplification estimates
- [Plan-004: Session Event Taxonomy and Audit Log](../plans/004-session-event-taxonomy-and-audit-log.md) — event taxonomy
- [Plan-009: Approvals, Permissions, and Trust Boundaries](../plans/009-approvals-permissions-and-trust-boundaries.md) — Cedar policy + approval categories
- [Plan-011: Artifacts, Files, and Attachments](../plans/011-artifacts-files-and-attachments.md) — artifact manifests and the artifact a step's output spills to
- [Plan-012: Persistence And Recovery](../plans/012-persistence-and-recovery.md) — `ProjectionRebuild` and recovery
- [Plan-013: Multi-Agent Orchestration](../plans/013-multi-agent-orchestration.md) — the orchestration run a multi-agent step starts through (CP-014-5)
- [Plan-003: Provider Driver Contract and Capabilities](../plans/003-provider-driver-contract-and-capabilities.md) — the CP-003-5 Cedar seam the agent tools adjudicate through (CP-014-7) and the typed usage-limit signal (CP-014-10)
- [Plan-017: Observability and Failure Recovery](../plans/017-observability-and-failure-recovery.md) — owner of the bounded-retention diagnostic bucket the SA-40 engine event record lands on (CP-014-9)
- [Spec-018: Observability and Failure Recovery](../specs/018-observability-and-failure-recovery.md) — the bucket diagnostic tier and `Keep diagnostic logs for`, 7 days by default, that bound the engine record (I-014-18)
- [Spec-020: Data Retention, Export And Deletion](../specs/020-data-retention-export-and-deletion.md) — the erasure paths whose Path 3 the engine record's bucket joins through Spec-018
