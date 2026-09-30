# Workflow Step Model

## Purpose

Define how one node of a workflow runs inside a workflow run: the step record each attempt leaves, the statuses a step moves through, how a step waits, and how a failure on a node is handled.

## Scope

This document covers the nodes of a workflow's authored document as they run (static), `WorkflowStep` (runtime), step statuses and wait causes, the kinds that run an agent or ask a person, and per-node error handling. The definition, its versions and the workflow run are defined in the companion [Workflow Model](./workflow-model.md).

## Definitions

- `WorkflowDocument`: the authored body a workflow version snapshots — exactly one trigger node, the rest of the graph as nodes, and the edges between them. Every kind the runtime offers is a node of that document, and nothing is compiled into a second shape when the document is saved.
- Node: one element of the document — its kind and kind version, its params, and optionally `onError`, `retry` and `disabled`. The kinds that run an agent or ask a person are nodes like any other; their executors call the existing run, orchestration, approval and form paths when the node runs.
- `WorkflowStep`: the runtime record of one attempt of one node, keyed by the workflow run, the node and the attempt number. It carries the step's `executionIndex`, its `source`, its status, its timings, the references to its input, output and log, its cost, its error, and the deadline of a wait on a person where one is set. One step record exists per node attempt, which is what gives a branching run a faithful account of what happened when.
- `executionIndex`: a per-run number that increases with every step, giving the steps of a run one total order whatever the graph's shape.
- `source`: for each input of a step, the edge that fed it and which execution of the source node produced it, so a step fed by the third pass of a loop says so.
- `StepRunId` (`step_run_id` on the wire and in storage): the identity of one step attempt, derived as `BLAKE3(workflowRunId || nodeId || attemptNumber)` — every bit a function of that preimage, none from a clock or entropy source, so replay reproduces the identical sequence. It is **not** a `RunId` from the run state machine and not a ULID: an agent step _creates_ runs, each with its own `RunId`, while the `StepRunId` names the step attempt that created them ([Spec-015 §Deterministic identity (SA-21)](../specs/015-workflow-authoring-and-execution.md#deterministic-identity-sa-21); the digest's concrete text rendering is open per [Spec-015 §Open Questions](../specs/015-workflow-authoring-and-execution.md#open-questions)).
- Wait cause: why a `waiting` step waits — `approval`, `form` or `reply` when it waits on a person, `chain` when its child run is held behind its chain's question, `account` when it is parked on a spent provider account.
- `waitId`: the durable identity of one wait, tying it to its run, its step and its session.
- `onError`: what a failure on a node does — `stop` (the run fails), `continue` (the step's input passes on) or `continue-error-output` (the failed items go down the node's `error` output).
- `retry`: `{ maxTries, waitMs }` on a node, the number of attempts a failing node gets and the pause between them, clamped by the engine.

## What This Is

The workflow step model describes how each node of a workflow executes within a run, how a step waits and resumes, and how a failure on a node is handled.

## What This Is Not

- A step is not an independent run. An agent step creates runs — `agent.run` through the run admission, `agent.multi-agent` through `orchestration.runCreate` — and each of those runs has its own lifecycle per the run state machine.
- A step status is not a run status. Step statuses track one node attempt; the workflow run's statuses are in the [Workflow Model](./workflow-model.md).
- An approval is not a gate between steps. It is a `human.approval` node with `approved` and `rejected` outputs, whose request goes through the Plan-010 approval pipeline and Cedar, and whose resolution is recorded in `workflow_gate_resolutions`.
- A retry is not unbounded. A node's `retry` is clamped by the engine and never trusted from the document; across runs, the chain's count and its one question bound runs that start runs.
- A step is not a conversation of its own. `agent.multi-agent` runs a lead and the helpers it starts in the run's own session.

## Agent And Person Steps

The kinds that run an agent or ask a person ([Spec-015 §Node-Kind Taxonomy](../specs/015-workflow-authoring-and-execution.md#node-kind-taxonomy)):

| Kind | What its step does |
| --- | --- |
| `agent.run` | Calls the run admission with the agent definition its `definition` param names, and the provider account, permission level and allowlist resolved from that definition under any per-node `binding` override. |
| `agent.multi-agent` | Runs a lead and the helpers it starts in the run's own session through the orchestration path (`orchestration.runCreate`); what the orchestration run returns becomes the step's output. |
| `human.approval` | Raises a request through the approval pipeline and Cedar and waits with cause `approval`; the answer routes the step's items down its `approved` or `rejected` output. |
| `human.form` | Waits with cause `form` for a person to fill its fields, keeping the draft in the form-state store as it is typed; the submission becomes the step's output. |
| `human.wait-for-chat-reply` | Waits with cause `reply` on the session's own question card; the answer becomes the step's output. |

Every other kind — the flow, file, developer and output kinds — runs its own executor inside the daemon under the same step record, statuses and error handling.

## State Model

Step statuses are these:

| Status | Meaning |
| --- | --- |
| `pending` | The step has not started. It is waiting for all its `main` inputs to settle. |
| `waiting-memory` | The step is ready, and the memory gate is holding it until the machine has room for it. It starts itself when room appears. |
| `running` | The step is executing. |
| `waiting` | The step has suspended on one of the wait causes and holds a resume token under its `waitId`. |
| `succeeded` | The step finished and produced its output. |
| `failed` | The step ended in failure. A step cut by a time limit — its own `Timeout`, its wait's deadline or the run cap — reads `failed · timed out`. |
| `skipped` | The step's input carried no items and its node does not set `alwaysOutputData`. |
| `canceled` | The step was running or waiting when its run ended failed or canceled, or it was on a branch a `First to arrive` merge canceled. |

Allowed transitions:

- `pending -> waiting-memory` (the step is ready and the memory gate holds it)
- `pending -> running`, `waiting-memory -> running` (the gate admits the step)
- `pending -> skipped` (its input carries no items)
- `running -> waiting` (the step suspends on a person, a held child run or a spent provider account)
- `waiting -> running` (the wait is answered, the chain's question is answered with `Keep going`, or the account recovers)
- `running -> succeeded` (execution succeeds)
- `running -> failed` (execution fails or a time limit cuts it)
- `waiting -> failed` (the wait's deadline passes)
- `running -> canceled`, `waiting -> canceled` (the run ends failed or canceled, or a `First to arrive` merge cancels the branch)

`succeeded`, `failed`, `skipped` and `canceled` are terminal. A retry never moves a terminal step: it writes a new step record with the next attempt number.

## Waiting

A node that suspends stores a resume token on the run under its `waitId`, sets the wait's deadline where one exists, offloads its run data, and resumes on the matching answer or timer. Approval, form and chat-reply waits ride this one mechanism.

| Cause | Where it comes from | What ends it |
| --- | --- | --- |
| `approval` | a `human.approval` step | the person's answer, in the approvals surface or in the step's panel |
| `form` | a `human.form` step | the person's submission in the step's panel |
| `reply` | a `human.wait-for-chat-reply` step | the person's answer on the session's question card or in the step's panel |
| `chain` | a `flow.execute-workflow` step whose child is held behind its chain's question | `Keep going`, which starts every held run, or `Stop them all`, which cancels every run of the chain |
| `account` | an agent step whose provider account is spent | the account recovering, at the resume instant where one is armed |

- The kinds that wait on a person carry a `Timeout` param, empty by default, meaning the step waits until it is answered. Set, the deadline is written on the step's row when it starts waiting, and a deadline that passed while the daemon was stopped fires at once on start. At the deadline the step fails with `workflow.step_timed_out`, and the node's `onError` decides what follows.
- One answer or the deadline, whichever comes first, settles a wait everywhere at once. An answer after that is refused with `workflow.step_not_waiting`, and the answer is tied to its question, never to whichever message arrives first.
- A waiting step holds no memory reservation, and time a step spends waiting on a person never counts against the run cap.
- The start of a wait on a person is its escalation: the bell counts it and `Waiting on you` is posted once on every device the person uses.

## Errors, Retries And Timeouts

Error handling lives on the node that failed, inside the document body stored on `workflow_versions`; the document holds no settings block for it.

- `onError`: `stop` fails the run and cancels every branch still running; `continue` passes the step's input on; `continue-error-output` sends the failed items down the node's `error` output and the run continues.
- `retry { maxTries, waitMs }`: a failing node is tried again up to `maxTries` times, `waitMs` apart, each attempt its own step record. The engine clamps both values and never trusts them from the document. When the last attempt fails, `onError` takes effect.
- Per-item errors ride the item itself, so one item can fail while the rest of a batch succeeds.
- A `flow.stop-error` node makes a deliberate failure a visible element of the graph.
- `Timeout`: the agent run, the shell command and the kinds that wait on a person carry one, empty by default, meaning none; a Code step's is 5 s by default. The run cap is `Stop a run after` on Settings › Runtime, off by default.
- A failure lands on the node and in the session event log. The error trigger, which starts another workflow when a run fails, is a convenience on top of that record, never the only place a failure shows.

## Invariants

- One step record exists per node attempt. A step reaches exactly one terminal status (`succeeded`, `failed`, `skipped` or `canceled`) and never moves again; a retry is a new record.
- A node runs only when all its `main` inputs have settled. The one exception is a `flow.merge` in `first-to-arrive` mode, which passes on the first branch to succeed and cancels the others.
- Every step boundary emits one event — `workflow.step_started`, `workflow.step_finished`, `workflow.step_failed`, `workflow.step_canceled` or `workflow.step_skipped` — into the session event log. The step rows one turn of the engine's loop starts or settles commit in one transaction, and that turn's events reach the log as one batch.
- An agent step creates runs only through the run admission or `orchestration.runCreate`. A step never bypasses the run state machine.
- When a run ends failed or canceled, every sibling branch still running is canceled through the executors' cooperative abort and its steps read `canceled`, so nothing the run started goes on acting after it has ended.
- A waiting step is never swept to `crashed` on daemon start and never pruned.
- A step's payload over 64 KiB becomes an artifact with `artifactType: 'workflow_output'` and the step row keeps the reference; a smaller payload is inline JSON on the step row.
- A step record stores a secret's reference, never its value, and every resolved secret is redacted from logs and step payloads before they are written.
- A gate is one of two kinds: a `human.approval` step's question or a chain's question. Each answer is appended to `workflow_gate_resolutions`, keyed by the run, naming the step's node for a `human.approval` gate and no node for a chain's; a row is never rewritten. A form step is not a gate: its answer is the step's output.

## Relationships To Adjacent Concepts

- `WorkflowRun` (from the [Workflow Model](./workflow-model.md)) is the parent container. A run holds one `WorkflowStep` per node attempt, in `executionIndex` order.
- The node in the version's document provides the static configuration: kind, params, `onError` and `retry`.
- `Run` (from the run state machine) is the execution primitive an agent step uses. Each `agent.run` attempt creates at least one run; each `agent.multi-agent` attempt creates one orchestration run in the workflow run's session.
- `Agent` executes agent steps. The agent definition is named in the node's own `definition` param.
- `Artifact` holds a step's payload over 64 KiB as a `workflow_output` artifact, and a step's output can be opened as an artifact.
- `Approval` (from Plan-010) is what a `human.approval` step raises; its resolution is recorded in `workflow_gate_resolutions` and emitted as `workflow.gate_resolved`.
- `SessionEvent` timeline captures step events: `workflow.step_started`, `workflow.step_finished`, `workflow.step_failed`, `workflow.step_canceled`, `workflow.step_skipped`, `workflow.gate_resolved`. The list is illustrative; the full set of `workflow.*` types is in [Spec-015 §Workflow Timeline Integration](../specs/015-workflow-authoring-and-execution.md#workflow-timeline-integration).

## Example Flows

- Example: An `agent.run` step implements a change and a `human.approval` step follows it. The agent's run finishes, the approval step waits with cause `approval`, and `Waiting on you` is posted once. The person approves from the step's panel; the answer settles the wait everywhere and the items go down the `approved` output to the next step.
- Example: An `agent.run` step with `retry { maxTries: 3, waitMs: 5000 }` and `onError: stop` fails three times. Each attempt leaves its own step record; after the third the run fails, and a sibling branch still running is canceled, its steps reading `canceled`.
- Example: A `human.form` step has a `Timeout` of one hour and the machine sleeps overnight. On wake the deadline has passed, so the step fails with `workflow.step_timed_out` at once; its node's `onError` is `continue`, so the step's input passes on and the run goes on.
- Example: An agent step's provider account is spent. The step waits with cause `account` and resumes itself when the account recovers, at the resume instant where one is armed.

## Edge Cases

- A node whose input carries no items is `skipped` unless it sets `alwaysOutputData`; a disabled node passes its input straight to its output.
- A loop node re-executes under a new run index each time its body's last node feeds back into it, so one node can leave many step records in a run; `$runIndex` and `source` tell them apart.
- If a run is canceled while a step is parked, there is nothing to interrupt — a parked step holds no live process and no reservation — so the cancel completes immediately, preserving the step's recorded park reason and cause while clearing its live resume schedule and attention key in the same unit of work ([Spec-015 §Park integrity and cancellability (SA-42)](../specs/015-workflow-authoring-and-execution.md#park-integrity-and-cancellability-sa-42)).
- A canceled branch counts as settled only after its last edit has reported and the daemon has read the checkout from disk, because an interrupt does not stop an edit already under way.
- One step is always admitted, so the memory gate never deadlocks; when nothing is running, the step at the head of the line is admitted whatever its size.
- A full-tier Code step or a shell step whose sandbox cannot start at the Sandboxed level refuses with `workflow.sandbox_unavailable` and takes its node's `onError` from there; it never runs unprotected.

## Related Specs

- [Workflow Authoring And Execution](../specs/015-workflow-authoring-and-execution.md)
- [Multi-Agent Orchestration](../specs/014-multi-agent-orchestration.md)
- [Queue Steer Pause Resume](../specs/003-queue-steer-pause-resume.md)
- [Approvals Permissions And Trust Boundaries](../specs/010-approvals-permissions-and-trust-boundaries.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [Visual Node-Graph Workflow Authoring](../decisions/026-visual-node-graph-workflow-authoring.md)
