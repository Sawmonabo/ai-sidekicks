# Workflow Tool Texts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

Every word a model reads from thirteen of the sixteen workflow tools ([Spec-015 §Chat-Invoked Start and Start Authorization](../../specs/015-workflow-authoring-and-execution.md#chat-invoked-start-and-start-authorization)): each one's description, its fields, what its result says, and its errors. `workflow_run`'s text sits with its definition in `crates/sidekicks-contracts/src/workflow/run/tool.rs`, and `workflow_create` and `workflow_update` take their field text from the workflow document contract. The texts are written once in the daemon's workflow agent tools: an input that differs from its method's request, and its field text, in `inputs.rs`, and each description and handler in `callback.rs`. `workflow_list` takes `workflow.definition.list`'s request unchanged, so its field text is that request's own. The texts are plain constants, tuned once real sessions show how each model uses them, and no test checks their wording.

No tool takes a session: the daemon derives it from the invoking turn. Fields are snake_case, mapped to the wire's lowerCamelCase. The reads and the authoring tools name a workflow by its id from `workflow_list`, and the two start tools by its name. Claude Code keeps these tools behind its tool search, so each description's first sentence is what a search matches; and each field's description states its limits in words, because Codex shows the model no ranges or patterns.

## `workflow_kinds`

```
List every node kind a workflow can use: each kind's id, display name, inputs, outputs and parameters with their types. Read it before writing a workflow with workflow_create or workflow_update, so each node names a kind and parameters that exist.
```

No fields. Result, one block per kind: `agent.run · Run an agent · inputs: main · outputs: main · params: agent (agent), instructions (string) …`

## `workflow_list`

```
List the workflows in the library, a page at a time: each one's id, name, latest version, trigger, whether its triggers are on, its schedule and next run, its last run, tags and run count.

{}
{"cursor": "…"}
```

Fields (`workflow.definition.list`'s request unchanged):

- `limit` (optional): `The most workflows to return.`
- `cursor` (optional): `The cursor a previous call returned, to read the next page.`

Result, one line per workflow, ending `More: next_cursor "…"` when there is more:

```
wf-7c1 · nightly-deps · v4 · schedule · on · weekdays at 8:00 AM America/New_York · next Oct 16 at 8:00 AM · last run succeeded Oct 15 at 8:00 AM · 31 runs
```

Empty: `No workflows yet.`

## `workflow_read`

```
Read one workflow's document, at its latest version or a version you name; with diff_from_version, also what changed since that earlier version. Read the latest before workflow_update, which names the version you read.

{"definition_id": "wf-7c1"}
{"definition_id": "wf-7c1", "diff_from_version": 3}
```

Fields (`definition_id` required):

- `definition_id`: `The workflow's id, from workflow_list.`
- `version` (optional): `The version number. Omitted, the latest.`
- `diff_from_version` (optional): `An earlier version number; the result adds what changed since it.`

Result: `nightly-deps · version 4 of 4 · <the document>`; with `diff_from_version`, then `Changed since version 3:` and each node added, removed or changed, before and after. A deleted workflow still reads.

## `workflow_runs`

```
List workflow runs, newest first: each run's id, workflow, status, trigger, who started it, when, how long it took, its step count and its cost.

{"definition_id": "wf-7c1", "status": ["failed"]}
```

Fields (all optional):

- `definition_id`: `Only runs of this workflow, by its id from workflow_list.`
- `workflow_version_id`: `Only runs pinned to this version of that workflow; send it only with definition_id.`
- `status`: `Only runs in one of these statuses: new, running, waiting, succeeded, failed, canceled, crashed.`
- `trigger_kind`: `Only runs started by one of these triggers, such as trigger.schedule or trigger.chat.`
- `started_after`, `started_before`: `Only runs started after, or before, this instant, such as 2026-10-15T08:00:00Z.`
- `limit`: `The most runs to return.`
- `cursor`: `The cursor a previous call returned, to read the next page.`

Result, one line per run, ending `More: next_cursor "…"` when there is more:

```
r-912 · nightly-deps · failed · schedule · Oct 15 at 8:00 AM · 2 min 14 s · 6 steps · $0.18
```

Empty: `No runs match.`

## `workflow_run_read`

```
Read one run: its workflow and version, status, trigger, who started it, its timings, and every step with its status; a waiting run also names the step that waits and why.

{"workflow_run_id": "r-912"}
```

Field: `workflow_run_id`: `The run's id, from workflow_runs or workflow_run's result.`

Result: the run's header, then one line per step: `n4 · Run tests · attempt 1 · failed · 41 s`. Read a step's items with workflow_step_read.

## `workflow_step_read`

```
Read one step of a run: the items it ran on, the items it produced, or its log, a page at a time. Secret values were removed before anything was stored, so a read never returns one.

{"workflow_run_id": "r-912", "node_id": "n4", "attempt": 1, "execution_index": 0, "which": "log"}
```

Fields (all but `limit` and `cursor` required):

- `workflow_run_id`: `The run's id.`
- `node_id`: `The step's node id, from workflow_run_read.`
- `attempt`: `Which attempt at the step, counted from 1: each retry is a new attempt.`
- `execution_index`: `Which execution of the node, counted from 0 and increasing through the run.`
- `which`: `"input" for the items it ran on, "output" for the items it produced, "log" for its log.`
- `limit` (optional): `The most items to return.`
- `cursor` (optional): `The next_cursor from the previous page.`

Result: the page, ending `More: next_cursor "…"` when there is more. A payload stored as an artifact comes back as its reference.

## `workflow_validate`

```
Check a workflow document as a save would, without saving it. The result lists every finding a save would refuse, each with its rule and the nodes it names, or says a save would accept it.

{"document": {…}}
```

Field: `document`: `The document to check. The result lists every finding a save would refuse.`

Results: `Valid: a save would accept this document.` · `2 findings a save would refuse:` then one line each, such as `cycle · nodes n3, n5` and `param_missing · node n4 · <detail>`, in the contract's rule words.

## `workflow_schedule_set`

```
Set or turn off the schedule of a workflow's schedule trigger: a cron expression, every N minutes, hours or days, or off. It saves a new version of the workflow, so name the version you read; a save made since then refuses it.

{"definition_id": "wf-7c1", "expected_version_number": 4, "expression": "0 8 * * 1-5", "time_zone": "America/New_York"}
```

Fields (all but `time_zone` required):

- `definition_id`: `The workflow's id, from workflow_list.`
- `expected_version_number`: `The version number read before this change; refused if a newer version exists.`
- `expression`: `A cron expression, such as 0 8 * * 1-5; every followed by a number and m, h or d, such as every 2h; or off, which stops the schedule.`
- `time_zone` (optional): `The IANA time zone a cron expression is read in, such as America/New_York. Required with a cron expression.`

Results: `nightly-deps runs weekdays at 8:00 AM · next Oct 16 at 8:00 AM · saved as version 5.` · `nightly-deps runs every 2 hours · next Oct 15 at 10:00 PM · saved as version 5.` · `nightly-deps's schedule is off · saved as version 5.`

Errors:

- A newer version exists: `Not saved: version 4 is no longer the latest. Read the workflow again with workflow_read and retry.`
- No schedule trigger: `Not saved: nightly-deps has no schedule trigger. Add one with workflow_update.`
- A cron expression with no time zone: `Not saved: a cron expression needs time_zone.`

## `workflow_enable`

```
Turn a workflow's triggers on or off. Off, none of its triggers starts a run until it is turned on again.

{"definition_id": "wf-7c1", "enabled": false}
```

Fields (both required):

- `definition_id`: `The workflow's id, from workflow_list.`
- `enabled`: `true turns every trigger on; false turns them all off.`

Results: `Enabled nightly-deps · 1 trigger on.` · `Disabled nightly-deps.`

Error, a trigger that cannot be armed: `Not enabled: a trigger of nightly-deps cannot be turned on (<the daemon's words>). Nothing was turned on.`

## `workflow_node_execute`

```
Run one node of a saved workflow, or the node and every node before it, as the builder's Run this node and Run from here do. The run lives in this session and works in its folder, or in the repository of the project you name. The daemon decides which nodes run again and which reuse data from earlier runs.

{"definition_name": "nightly-deps", "node_id": "n4", "scope": "fromHere"}
```

Fields (`definition_name`, `node_id` and `scope` required):

- `definition_name`: `The workflow's name: at least one character.`
- `version` (optional): `The saved version number to run. Omitted, the latest.`
- `node_id`: `The node's id, from workflow_read.`
- `scope`: `"node" runs the node alone; "fromHere" runs it and every node before it.`
- `project` (optional): `workflow_run`'s own `project` text, unchanged.

Result: `Run r-915 · ran n1, n2, n4 · reused n3.`

Error, a node that needs a repository: `Not run: nodes n4 need a repository. Name a project from session_options.`

## `workflow_cancel`

```
Cancel a run that has not ended: one that is new, running or waiting, or a failed run parked on its failed step.

{"workflow_run_id": "r-912", "reason": "The person asked to stop the nightly run."}
```

Fields (`workflow_run_id` required):

- `workflow_run_id`: `The run's id, from workflow_runs.`
- `reason` (optional): `Why, in a sentence. It is recorded on the run; no step and no agent reads it.`

Results: `Canceled r-912.` · `r-912 was already canceled.`

Error, a run that has ended: `Not canceled: r-912 has already ended.`

## `workflow_resume`

```
Resume a run that is waiting, or a failed run parked on its failed step. It continues on the version it was pinned to; to move it to another version of its workflow, name that version.

{"workflow_run_id": "r-912"}
```

Fields (`workflow_run_id` required):

- `workflow_run_id`: `The run's id, from workflow_runs.`
- `version_repin` (optional): `Move the run to another version of its workflow. Omit to continue on its own version.`
- `version_repin.target_workflow_version_id`: `The version id to move to, from workflow_list or workflow_read.`

Results: `Resumed r-912.` · `r-912 is waiting again: a provider account it needs is still out of quota.`

Errors: a run that is not parked: `Not resumed: r-912 is not waiting.` A re-pin refused: `Not resumed: <the daemon's words>.`

## `workflow_results_post`

```
Post a finished run's results into this session's transcript as its results row, for the person to see. A run started in this session posts its results here on its own when it ends; use this for any other finished run.

{"workflow_run_id": "r-912"}
```

Field: `workflow_run_id`: `The finished run's id, from workflow_runs.`

Result: `Posted r-912's results into this session.`

Error, a run that has not finished: `Not posted: r-912 has not finished.`

## Errors every workflow tool shares

- No such workflow or run: `No workflow with id "wf-7c9". Call workflow_list to see them.` / `No run with id "r-919". Call workflow_runs to see them.`
- A start the policy denies: `Workflow start denied: <the daemon's message>.`
- An author, cancel or resume the policy denies: `Denied: needs permission to author workflows.`, and cancel and resume in their own action's words.
- Approval declined by the person: the provider's own refusal, passed through unchanged.
- Bad arguments (`failed`): `Not done: <what the arguments got wrong>.`
