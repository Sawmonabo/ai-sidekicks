# BL-097 Pass C — `human` Phase UX and Contract

**Date:** 2026-04-22
**Pass:** C (of parallel Wave 1)
**Scope:** Semantic boundary, UX surface, resumability, and timeout/escalation for a `human` workflow **phase type** that is distinct from Spec-012's `human-approval` **gate**. Pass is research-only; the Wave 1 synthesis pass chooses between BL-097 resolution candidates α, β, γ-i, γ-ii, γ-iii.
**Audience:** Wave 1 synthesis agent and anyone deciding γ-iii (`human` phase in V1).

---

## 1. Problem Framing

### 1.1 Why this pass exists

BL-097 asks whether V1 ships the full Spec-017 workflow engine (γ-iii, which includes the `human` phase type). A decision-grade answer needs a concrete contract for the phase type that (a) does not collide with Spec-012's existing `human-approval` gate, (b) fits the V1 guardrails the BL-097 Summary already commits to (SQLite suspend/resume, `predecessors: PhaseId[]` schema), and (c) reuses existing V1 primitives wherever possible.

### 1.2 The three-way contract distinction (not two)

The task brief names two primitives — "phase type" vs "gate." The canonical docs actually already enumerate **three** human-involving primitives:

| # | Primitive | Category / Type | What it is | When it fires | Output shape |
|---|---|---|---|---|---|
| 1 | `user_input` approval | Spec-012 approval `category: user_input` | Agent mid-run pauses to ask the human a freeform question, receives a reply, resumes. The agent owns the phase; the human contributes a single datum. | **Inside** a phase, during agent execution. | String (or lightly-typed reply) consumed by the agent's next turn. |
| 2 | `human-approval` gate | Spec-017 gate + Spec-012 approval `category: gate` | After a phase produces output, a human reviews that output and emits a binary decision (approve / reject + optional correction). | **Between** phases, after one completes and before the next starts. | `{decision: approve \| reject \| correct, correction?: string}`. Approved gate opens; rejected triggers `retry` or `stop`. |
| 3 | `human` phase type | Spec-017 phase `type: human` (V1.1 today; γ-iii pulls into V1) | The phase itself is human work. No agent runs in it. The human produces the phase output. | **As a phase** in its own right. | `{artifacts: ArtifactId[], summary: string, metadata: Record<string, unknown>}` — same shape as `automated` or `single-agent` phases. |

See `docs/specs/012-approvals-permissions-and-trust-boundaries.md:48-56` for the eight-category approval enum (`user_input`, `gate`, `mcp_elicitation` all present) and `docs/specs/017-workflow-authoring-and-execution.md:42` for the phase-type list. The LangGraph `interrupt()` pattern (see §3.1 below) and MCP `elicitation/create` (MCP spec 2025-06-18) collapse (1) into a generic "pause and ask" primitive — AI Sidekicks has already chosen not to collapse, so (1) vs (3) is a **settled** architectural choice, not Pass C's to revisit. **What Pass C owns is (3)'s contract, defined so it does not drift into (1) or (2).**

### 1.3 What V1 already ships (the substrate for `human` phase)

Per Spec-017 and the V1 scope decision in §40 of that spec, V1 already ships:

- `PhaseRunStatus: pending | running | completed | failed | skipped` (all five).
- `GateResultStatus: passed | failed | waiting-human` — `waiting-human` is already a first-class result.
- `human-approval` gate semantics: block the gate, surface to UI, resolve via Spec-012 `ApprovalResolve`.
- Phase output schema `{artifacts, summary, metadata}` stored as artifacts of type `workflow_output`.
- Durable workflow persistence per Plan-017 (LangGraph-checkpoint pattern on SQLite per Spec-015).

The BL-097 Summary explicitly commits V1 to a **SQLite suspend/resume state machine "so V1.1 `human` phase ships as UI/API addition, not schema migration."** The same state machine serves γ-iii: a V1 `human` phase is the `waiting-human` gate machinery relocated — instead of the gate blocking between phases, the phase itself blocks in `running` state awaiting a typed payload from a participant.

---

## 2. Q1 — Semantic boundary between `human` phase and `human-approval` gate

### 2.1 The boundary, stated

**A `human` phase produces a new output; a `human-approval` gate evaluates an existing output.**

Concretely:

| Axis | `human-approval` gate | `human` phase |
|---|---|---|
| Precedes vs produces | Evaluates the prior phase's output. | Produces its own phase output. |
| Output arity | Binary (approve / reject) ± correction text. | Arbitrary typed artifact(s) + summary + metadata. |
| What the UI asks for | "Do you approve this?" | "What is your output for this step?" (answer may be a file, form, freeform text, or artifact reference). |
| Retry semantics | Reject can `retry` the preceding phase or `stop`. | Phase runs normally; own retry/failure behaviors apply. |
| Timeline position | Between phases. | As a phase. |
| Cedar action (per Spec-012) | `category: gate` | `category: user_input` *or* a new `category: human_phase_contribution` (see §2.4). |

This mapping matches Forge's implementation (`packages/contracts/src/workflow.ts`: `PhaseType = "single-agent" | "multi-agent" | "automated" | "human"` and `GateAfter = "auto-continue" | "quality-checks" | "human-approval" | "done"`), which treats phase type and gate as independent enums. See `docs/reference/forge/contracts-desktop.md:364-368`. Forge's `human` phase produces artifacts; its `human-approval` gate resolves with `{humanDecision, correction}`. The two are not redundant.

### 2.2 Can they be one primitive with modes?

**Technically yes; architecturally no.** LangGraph's single `interrupt()` serves approval, edit, and reject use cases from one primitive (LangChain docs, langchain.com/oss/python/langchain/human-in-the-loop). GitHub Actions' required-reviewers protection (github.com/docs/actions/.../reviewing-deployments) is a binary-only gate with no input. These two sit at opposite ends of the expressiveness spectrum, and **AI Sidekicks has already committed to the explicit-category architecture** (Spec-012's eight-category enum; Spec-017's phase-type / gate-type split). Reopening that is out of scope for Pass C.

The narrower technical question — "can the V1 `human-approval` gate infrastructure be reused to implement a `human` phase by just widening the resolution payload?" — answers **yes, with one addition**: a `human` phase resolves to `{artifacts, summary, metadata}` (the standard phase output shape) rather than to `{decision, correction}`. The underlying waiting-human plumbing (WS subscription, `waiting-human` state on a runtime record, durable persistence) is identical. This is the guardrail the BL-097 Summary already commits to.

### 2.3 What keeps them distinct in the contract

Three load-bearing differences that the API schema must preserve:

1. **Addressing.** A `human-approval` gate is addressed by `(PhaseRunId, gate)`; a `human` phase is addressed by `(PhaseRunId)` directly. One is the resolution of a check on a prior output; the other is the production of a new output.
2. **Output shape.** Gate resolution payload is `{decision, correction?}`; phase resolution payload is `{artifacts, summary, metadata}`. Downstream schema consumers must not have to switch on phase type to read an output.
3. **Event taxonomy.** Spec-017 already emits `workflow.gate_resolved` (with `waiting-human` result) for gates. A `human` phase reuses `workflow.phase_started` / `workflow.phase_completed` with `phaseType: "human"` — the same events agent phases emit. No new event types are required.

### 2.4 Cedar principal / authorization

Spec-012 requires every sensitive action run through Cedar: `principal = participant`, `action = approval category`. Two options:

- **(a) Reuse `category: user_input`.** Works if the V1 policy treats "human contribution to a workflow phase" as the same kind of action as "agent asked a freeform question mid-run." Lower schema surface; slightly less granular audit.
- **(b) Add `category: human_phase_contribution`.** Clearer audit boundary (matches the phase-type / approval-category one-to-one convention already in place for `gate`). Requires a Spec-012 enum extension and a Plan-012 YAML policy update.

**Recommendation (Pass C contract):** option (b), because Spec-012's eight-category enum already treats `gate` and `user_input` as distinct despite both being human-mediated — adding `human_phase_contribution` maintains that granularity.

---

## 3. Q2 — UX surface: what to ask a human, and how

### 3.1 Reference-implementation survey

| System | Primitive | Input types the human sees | Output typing |
|---|---|---|---|
| Argo Workflows `suspend` template | `suspend: {}` with intermediate parameters | Text, dropdown (enum). Argo 3.5+ parameterizes suspend duration. Parameter types are strings with `enum` for dropdowns. No native file upload. | Output parameters set via `argo node set` CLI or `/set` API endpoint. |
| Camunda 8 user task | BPMN `userTask` | Camunda Forms: text, number, date, select, multi-select, file (attachment), checkbox. Assignee + candidate groups. Due date + follow-up date. | Variables merged into process instance (output mapping). |
| GitHub Actions environments | Required reviewers on a job | Approve / reject + optional free-text comment. | Binary. Comment stored in deployment log; **not** a typed output. |
| Jira workflow transitions | Transition screen with validators | Required custom fields via "Field(s) required validator" (ScriptRunner / JSU / native Cloud validator). Full Jira field palette: text, select, user, date, attachment. | Fields persist on issue; transition succeeds only if validator passes. |
| Zapier Human in the Loop (Aug 2025 GA) | Request Approval + Collect Data actions | Text, long text, dropdown, checkbox, multi-value. **Not** file uploads (inferred from docs available; the docs I could reach describe text fields). Approval has a `Timeout value` field. | Typed outputs passable to downstream Zap steps. |
| Activepieces Human Input piece | Web Form trigger + Respond on UI | Short text, long text, checkbox, multi-value, **file attachments**. | "Respond on UI" returns file or markdown text to the workflow. |
| Retool Workflows User Tasks (beta closed May 2025, GA rolling) | Approval step | Assigned to individuals or teams; pauses workflow. | Ships as Retool's native pause/resume primitive with typed payload. |
| LangGraph `interrupt()` | In-node interrupt with `Command(resume=...)` | Three decision types: `approve`, `edit`, `reject`. `edit` re-emits the original action modified. | Typed `{type, edited_action?, message?}` resumption payload. |
| Microsoft Agent Framework | `RequestPort<TReq, TResp>` or `ctx.request_info()` | Typed request/response. `RequestInfoEvent` emitted; the framework routes the typed response back to the executor. | Fully typed by generics. Checkpoints preserve pending requests. |
| Cloudflare Workflows | `step.waitForEvent(name, {type, timeout})` | Arbitrary JSON payload sent to an event endpoint. Example uses `{approved: boolean}`. | Untyped JSON; caller types at the step boundary. |
| MCP elicitation (spec 2025-06-18) | `elicitation/create` | Primitive JSON schema types: string, number, boolean, enum. Also URL-mode elicitation for out-of-band interaction. **Explicitly forbids PII/credentials** per MCP security rules. | Structured JSON object with primitive properties. |

### 3.2 The minimum viable input surface for V1

Two patterns converge across the survey:

- **Structured form, primitive types only** (Argo, MCP, Camunda's simple forms, Zapier Collect Data). A schema of `{name, type: text|long_text|number|boolean|enum, required}` covers 80 %+ of human-phase use cases with zero new UI work beyond a form renderer already needed for Spec-012 `mcp_elicitation`.
- **Attach-an-artifact** (Camunda file attachment, Activepieces file field, Retool User Tasks, Jira attachment). Needed for "reviewer uploads a signed-off PDF" or "operator drags in a design file" cases.

**Recommended V1 contract (if γ-iii ships `human` phase):**

```typescript
// Phase definition side (WorkflowDefinitionCreate / phase_definitions JSON)
type HumanPhaseConfig = {
  prompt: string;                 // Markdown body shown to the human
  inputSchema: HumanInputSchema;  // What they must provide
  assignees?: ParticipantRef[];   // Who may resolve; empty = any session participant with resolve capability
  dueAt?: IsoTimestamp;           // Soft SLA surfaced in UI, not enforced
  timeout?: Duration;             // Hard timeout (see §5)
  timeoutBehavior?: "fail" | "continue" | "escalate";
};

type HumanInputSchema = {
  fields: Array<
    | { name: string; type: "text" | "long_text"; required?: boolean; placeholder?: string }
    | { name: string; type: "number" | "integer"; required?: boolean; min?: number; max?: number }
    | { name: string; type: "boolean"; required?: boolean; default?: boolean }
    | { name: string; type: "enum"; required?: boolean; options: string[] }
    | { name: string; type: "artifact"; required?: boolean; acceptArtifactTypes?: string[] }
  >;
};

// Resolution payload (PhaseOutputRead / WorkflowGateResolve-equivalent)
type HumanPhaseResolution = {
  fields: Record<string, string | number | boolean | ArtifactId>;
  summary: string;                 // Free-text summary -> phase output
  metadata?: Record<string, unknown>;
};
```

Key choices, each with a cited rationale:

- **Primitive-type-only JSON schema** mirrors MCP's elicitation constraint (blog.fka.dev on MCP Elicitations, 2025-01; gofastmcp.com/servers/elicitation) and Argo's intermediate-parameters types. Avoids the nested-schema edge cases Camunda Forms had to add validators for. Maps cleanly to a single existing form-renderer component.
- **`artifact` field type** reuses the Spec-017 `ArtifactId[]` primitive — no new "file upload" plumbing. The human selects or uploads an existing-taxonomy artifact (Plan-014), which already supports signed manifests, attribution, and durability. Activepieces' Forms piece models this way (workflow references the uploaded file by URL/reference downstream); Camunda attachment fields likewise pass through an attachment ID, not raw bytes.
- **Why not rich Markdown/WYSIWYG input in V1:** Retool and Camunda both added rich editors later. Zapier's Collect Data ships text-only in 2025. V1 scope discipline says ship primitives + artifacts; rich-text is V1.x additive.
- **Why not file upload directly in the human phase form:** artifact-first keeps the provenance chain intact. Uploads bypass artifact signing unless re-plumbed. This matches ADR-014 (artifact signing) and Spec-017's output-mode spec.
- **Assignees is a list of participants, not a single user,** matching Camunda's candidate-groups pattern. This lets the phase resolve by the first eligible participant (first-claim-wins), which is how every production system (Camunda, Retool, Jira unassigned) handles it. Per Spec-012 §41, membership roles (`viewer / collaborator / runtime contributor / owner`) already exist — reuse them for authorization instead of inventing a new role.

### 3.3 Non-trivial UX details the contract must capture

1. **Re-entrant URL.** Spec-017 already commits workflow runs to be addressable (the timeline is durable). The `human` phase needs a direct deep link like `/session/:sid/workflow/:rid/phase/:pid` so a reviewer can bookmark and return. Argo, Camunda Tasklist, and Jira Kanban all provide this; it's table stakes.
2. **Draft autosave.** The browser may close before submit. Follow the WCAG 3 working draft (September 2025) and WCAG 2.2 §3.3.7 "Redundant Entry" direction: autosave draft locally (Dexie or IndexedDB) keyed on `(phaseRunId, participantId)`, restore on reopen. This is a client-only concern — no daemon contract change.
3. **Claim / unclaim.** Pattern from Camunda ("assign human tasks to groups, then require individual members to explicitly claim"). Avoids two participants filling the form simultaneously and stomping. V1 minimum: implicit claim on first open, optimistic-concurrency reject on submit if a different participant resolved first. Full Camunda-style claim/unclaim UI is V1.x.
4. **Progressive enhancement for accessibility.** Form must submit via plain POST if JS is disabled (WCAG 2.2 §3.2.2 "On Input" requires no surprise context changes). In V1 this is a `<form>` inside the existing Desktop Shell renderer that submits through the same WS channel as `ApprovalResolve`. One server handler, two input modes.
5. **Field validation before submit.** Reject at the API boundary if schema validation fails. Return typed error codes per `docs/architecture/contracts/error-contracts.md`. Do not silently accept and store malformed data — phase output is durable and replayable per Spec-017.

---

## 4. Q3 — Resumability: state preservation across human disappearance

### 4.1 What resumability means here

Three scenarios to survive:

- **(a) Browser tab closes during form fill.** Unsaved draft. Addressed by client-side autosave (§3.3.2).
- **(b) Participant submits, then the daemon restarts before the next phase starts.** Phase output must be durable at submit time, not on next-phase-start. Standard for any LangGraph checkpointer.
- **(c) Participant never returns, or returns N days later.** State persists indefinitely until timeout (§5) fires.

### 4.2 Durable-execution patterns from the survey

| System | Persistence mechanism | Max wait | Resume model |
|---|---|---|---|
| Argo Workflows | CRD in etcd; workflow-controller reconciles | Up to etcd TTL (effectively unbounded for most clusters) | `argo resume` CLI or automatic after `duration:` |
| Temporal | Event-sourced history; activities separate from workflow code | **No imposed time limit** — "Workflow Execution is durable because it executes to completion, whether for seconds or years" (temporal.io docs) | `workflow.wait_condition(..., timeout=...)` or omit timeout for indefinite wait |
| Cloudflare Workflows | Durable Objects (persistent compute instances) | "hours, weeks, or months" per Cloudflare docs | `step.waitForEvent(name, {timeout})` |
| AWS Step Functions | Task tokens, managed by the service | **1 year max** per docs.aws.amazon.com/step-functions/...; heartbeat extension possible via `SendTaskHeartbeat` | `SendTaskSuccess` / `SendTaskFailure` with the token |
| LangGraph | Checkpointer (Postgres / SQLite / in-memory) | Unbounded | `Command(resume={...})` with `thread_id` from config |
| Microsoft Agent Framework | Checkpoints (same framework as other state); pending requests survive restart | Unbounded | Pending requests re-emitted on restore; resolve via standard response flow (learn.microsoft.com docs) |

### 4.3 Recommended V1 approach

**Apply the BL-097 guardrail (1) — SQLite suspend/resume state machine — unchanged.**

- On phase start, insert a row into `phase_runs` with `status: running, phase_type: human`.
- When the UI opens the form, emit `workflow.phase_started` with a `phaseType: "human"` metadata key. The session timeline already durably captures this event (Spec-013 + Plan-006).
- When the participant submits, perform the following **atomically in one SQLite transaction** (per Spec-017 State and Data Implications):
  1. Write phase output artifact.
  2. Update `phase_runs.status` to `completed`.
  3. Emit `workflow.phase_completed`.
- If the daemon restarts mid-phase, the `running` row remains; on reconnect the WS API (`PhaseOutputRead`, workflow subscription) exposes it and the UI re-entry link works.
- No new persistence primitive. The resumability story is **identical** to the existing `waiting-human` gate story; only the resolution payload shape differs.

**Explicit non-goals for V1:**

- Distributed multi-node task assignment (Camunda's Zeebe partitioning). Single-daemon is the V1 model per ADR-002.
- Rich claim/unclaim protocol. Implicit claim + optimistic concurrency is enough.
- Long-polling or server-sent-events for UI updates beyond what Spec-017's WS API already offers.

### 4.4 Load-bearing invariants

Four invariants the implementation must hold (mirroring the Spec-017 "Pitfalls To Avoid" section):

1. Phase output must be durable before `phase_completed` is emitted — no "you submitted but it didn't land" states.
2. A `human` phase may not begin while the prior gate is `closed` (same as any phase type — Spec-017 Invariant).
3. Treating the human phase as a pure UI concern (a waiting banner) is forbidden — the phase state machine persists regardless of any UI.
4. Idempotency: re-submitting the same `(phaseRunId, participantId, fields)` must be a no-op, not a double-write or a new artifact (Argo, Temporal, and Step Functions all enforce this).

---

## 5. Q4 — Timeout, escalation, and never-returns semantics

### 5.1 Industry defaults (what production systems actually do)

| System | Default timeout | Max wait | On timeout |
|---|---|---|---|
| AWS Step Functions | None; docs.aws.amazon.com recommends **24 h (86400 s) default** ("Without it, a forgotten approval request will keep the execution running forever") | 1 year | Task fails; caller handles |
| Argo Workflows | None; `duration:` is optional | Unbounded | Auto-resume (not auto-fail — `duration` is an auto-continue, per argo-workflows.readthedocs.io `/walk-through/suspending/`) |
| Zapier Human in the Loop | Configurable `Timeout value` field; configurable timeout outcome | Not published | User-configured: fail, skip, or default value |
| GitHub Actions environments | **No native timeout**; reviewer must click through | Indefinite | N/A — run lingers until canceled |
| Temporal | None unless `wait_condition(..., timeout=...)` supplied | Truly unbounded | Exception; caller handles |
| Camunda 8 | `dueDate` is informational; no automatic escalation without BPMN timer boundary event | Unbounded | User-defined via BPMN escalation events |
| Jira | No implicit timeout on stuck transitions | Unbounded | Admin workflow; SLA plugins handle |
| Cloudflare `waitForEvent` | Required `timeout` param | Not published | Step throws / resolves null (depends on impl); caller handles |
| LangGraph | No timeout primitive in `interrupt()` | Unbounded | Out of scope — caller schedules externally |

**Pattern across the decade-old systems (Argo, Step Functions, Temporal, Camunda):** timeout is opt-in, not default. The default behavior is "wait indefinitely; the workflow is durable." This surprises users only if the UI doesn't make the pending state visible — and production systems all solve that via dashboards / queues, not by auto-failing.

**Pattern across newer low-code tools (Zapier HITL, Cloudflare `waitForEvent`):** required timeout with configurable on-timeout behavior. The trade-off: guardrails-by-default at the cost of forcing every author to think about expiry.

### 5.2 Escalation patterns (surveyed)

- **Reminder-then-escalate** (taskfoundry.com, mapsted.com industry writeups): reminder at 24 h, escalation to manager at 48 h. This is a widely-cited pattern in enterprise workflow tooling but is **authored on top of** the base timeout primitive, not baked into it.
- **Candidate groups** (Camunda): assign to a group; any member may claim. The "escalation" is implicit — any available human can resolve. No explicit reassignment needed.
- **Delegation** (Camunda + Jira): explicit reassignment action on the task. V1.x feature, not V1.
- **Queue-based routing** (Jira service management, Retool User Tasks): human tasks land in a shared queue; any authorized participant picks. This is the "candidate groups" pattern named differently.

### 5.3 Recommended V1 timeout contract

**Default: no timeout. Opt-in per phase definition. Three on-timeout behaviors, mirroring Spec-017's gate `onFail`:**

```typescript
timeoutBehavior?: "fail" | "continue" | "escalate";
// default: if `timeout` is unset, phase waits indefinitely and the session timeline
// reflects `waiting-human` state until resolved.

// On timeout:
// - "fail"   -> phase transitions to `failed`; workflow-level failure behavior applies.
// - "continue" -> phase transitions to `skipped`; downstream phases start.
//                 (Only valid if `inputSchema.fields` are all optional or have defaults.)
// - "escalate" -> emit `workflow.human_phase_escalated` event; phase remains `running`
//                 with `escalatedAt` metadata. V1.x may wire this to a notification
//                 channel; V1 ships the event only. (Mirrors Camunda BPMN escalation
//                 event — author must handle, framework does not auto-route.)
```

Why this shape wins:

- **Matches existing `onFail` vocabulary** (`retry | go-back-to | stop` already exist for gates). A new `timeoutBehavior` enum is parallel but not identical — phases can't usefully "retry" a human phase (a retry is a new phase run), and "go-back-to" is nonsensical for a human-authored output.
- **"No timeout" is the default because the surveyed majority default to it.** Anti-pattern avoided: forcing every workflow author to invent a timeout at authoring time (noise, inconsistency, authoring friction). Zapier HITL's required-timeout design is a reasonable opposite choice but presumes a notification-heavy operational model AI Sidekicks does not have at V1.
- **"Escalate" is an event-only primitive in V1.** Firing an event is zero new infrastructure — Spec-013 session events already exist. Actual routing to a user or queue is V1.x scope, deliberately deferred. Camunda BPMN follows the same pattern: the BPMN escalation event model is a *signal*, not a routing policy.
- **"Continue with defaults" requires all fields to have defaults or be optional.** The schema validator enforces this at `WorkflowDefinitionCreate` time, not at timeout time — a run-time "no valid default, so I guess I'll fail" is the kind of silent-failure Spec-017 §Pitfalls To Avoid already forbids.

### 5.4 Who can resolve? (authorization)

Per Spec-012 membership roles, the `human` phase contract must allow:

- Phase author names `assignees?: ParticipantRef[]`. If omitted, any session participant with `collaborator` role or higher (per Spec-012 §41 membership matrix) may resolve.
- Cedar policy evaluation uses `principal = submitting participant`, `action = human_phase_contribution` (if §2.4 option b is taken) or `user_input` (option a), `resource = PhaseRunId`, `context = session state`.
- Per Spec-012 §ApprovalResolve, the Cedar principal is the verified PASETO `sub` of the caller, not a body-provided hint. Same pattern applies to human-phase resolve — the resolver's identity is verified, not trusted from the request body.

---

## 6. V1 Recommendation (if γ-iii ships the `human` phase)

Pass C does **not** take a position on whether V1 should include the `human` phase. That decision belongs to Wave 1 synthesis with all three passes in hand. Pass C owns only the conditional: *if* γ-iii ships, here is the minimum viable contract.

### 6.1 Minimum viable contract summary

| Element | V1 commitment | Deferred to V1.x |
|---|---|---|
| Phase type enum | `human` becomes shippable in Spec-017 §40 | — |
| Approval category | Add `human_phase_contribution` to Spec-012 §48 enum (or reuse `user_input` — §2.4) | — |
| Phase config | `HumanPhaseConfig` per §3.2: prompt, inputSchema (primitives + artifact refs), assignees, dueAt, timeout, timeoutBehavior | Rich-text prompt renderer; workflow-editor form-builder |
| Input schema | Primitive types (`text`, `long_text`, `number`, `integer`, `boolean`, `enum`) + `artifact` (ArtifactId reference) | File-upload-in-form; nested objects; multi-value arrays; Markdown/WYSIWYG field |
| Output shape | `{fields, summary, metadata}` → `{artifacts, summary, metadata}` via standard phase output mapper | — |
| Assignment | `assignees: ParticipantRef[]` (implicit group); first-submit-wins with optimistic concurrency | Explicit claim/unclaim protocol; delegation; reassignment |
| Persistence | Reuse BL-097 guardrail (1) SQLite suspend/resume — zero new primitives | Distributed assignment across daemons |
| Re-entry | Deep-link URL `/session/:sid/workflow/:rid/phase/:pid`; client-side autosave draft | Server-side draft persistence; multi-device draft sync |
| Timeout default | No timeout (wait indefinitely); opt-in per phase | — |
| Timeout behaviors | `fail | continue | escalate` (escalate emits event only) | Notification routing; reminder chains; manager-escalation policy |
| Events | Reuse `workflow.phase_started`, `workflow.phase_completed`, `workflow.phase_failed`, plus new `workflow.human_phase_escalated` | Dedicated `workflow.human_phase_claimed` / `_unclaimed` |
| Authorization | Spec-012 Cedar, `principal = verified PASETO sub`, assignees list as `resource` context | Org-level approval routing policies |
| Accessibility | WCAG 2.2 AA form semantics; progressive enhancement via plain-POST fallback; WCAG 3 Redundant Entry §3.3.7 draft autosave | Screen-reader-optimized announce-ordered workflows |

### 6.2 What this contract deliberately doesn't do

- **No rich text or Markdown WYSIWYG editor.** Ship a `<textarea>` plus artifact reference. Retool, Camunda, and Zapier all added rich text later; none shipped it in their human-task MVPs.
- **No file upload inside the form.** Use artifact references. Uploads go through the artifact pipeline separately so signing (ADR-014) and provenance aren't bypassed.
- **No built-in reminder chain.** `escalate` event fires once; anything beyond that is V1.x notification-policy scope.
- **No explicit claim/unclaim UI.** Implicit first-submit-wins is enough for a team-of-a-few V1. Camunda's explicit claim is for hundreds-of-users enterprise queues.
- **No multi-reviewer `humanPhaseCompleted-requires-N-of-M` quorum.** That is gate-level multi-approval policy territory (Spec-012 §Default Behavior, "remembered approval rules `off` by default"), not phase-output policy.

---

## 7. Open Questions for Wave 1 Synthesis

**Ranked by impact on the BL-097 resolution.**

1. **[Highest] Approval-category choice between §2.4 (a) and (b).** Does Spec-012 gain a ninth category (`human_phase_contribution`), or does `user_input` stretch to cover phase-level human contributions? Affects Cedar policy authoring, audit granularity, and plan-012 YAML. Pass C recommends (b); a Cedar-policy-first pass may prefer (a) for schema stability.

2. **Escalation as event-only vs wired-to-notification.** Pass C recommends event-only in V1; if Spec-020 (observability/failure recovery) or a future notification spec defines a notify-on-event primitive in V1, escalation could become the first consumer of it. Check whether Spec-020 already commits to a notification primitive in V1 — if yes, wire them; if no, hold firm on event-only.

3. **Default timeout: none vs 7-day soft cap.** The survey shows a two-camp split (Argo/Temporal/Camunda = none; Zapier/Step-Functions-guidance = opt-in default). Pass C picked none (matches older durable-execution systems). A 7-day soft cap with `timeoutBehavior: "escalate"` default would be a defensible middle ground. Wave 1 synthesis may have telemetry-surface or user-research data Pass C does not.

4. **Client-side autosave storage.** `localStorage` vs `IndexedDB` vs daemon-side draft persistence. Local is zero-daemon-cost; daemon-side supports cross-device resume (which BL-097 did not scope). Pass C picked local; revisit when Spec-016 cross-machine collaboration lands in V1.

5. **Artifact field acceptance.** Should `type: "artifact"` allow any artifact type by default, or require `acceptArtifactTypes` to be set? Pass C's schema has it optional (no constraint); a future spec may want to tighten this for safety.

6. **Workflow editor UX for authoring `HumanPhaseConfig`.** Out of scope per Spec-017 Non-Goals ("Full UI design for workflow editors"), but the field-schema type union in §3.2 has a cost in authoring UX. A form-of-forms editor is what Camunda Modeler, Forge's `WorkflowEditor.tsx`, and Retool Workflow Editor all ship. Defer to V1.x or accept that authoring V1 `HumanPhaseConfig` is JSON-only at first.

7. **Interaction with `multi-agent` phase type (γ-i).** If γ-i lands separately, a hybrid "multi-agent phase with human tiebreaker" becomes obvious. Pass C does not take a position — belongs to a cross-phase-type pass.

---

## 8. References

All URLs fetched 2026-04-22 unless otherwise noted.

**Canonical analogues (highest weight):**

- Argo Workflows — Suspending templates walkthrough — `https://argo-workflows.readthedocs.io/en/latest/walk-through/suspending/`
- Argo Workflows — Intermediate Parameters — `https://argo-workflows.readthedocs.io/en/latest/intermediate-inputs/`
- Argo Workflows — `suspend-template-outputs.yaml` example — `https://github.com/argoproj/argo-workflows/blob/main/examples/suspend-template-outputs.yaml`
- Argo Workflows discussion #8365 — `Argo workflow suspend timeout if not approved and abort the workflow` — `https://github.com/argoproj/argo-workflows/discussions/8365`
- Camunda 8 — User Tasks — `https://docs.camunda.io/docs/components/modeler/bpmn/user-tasks/`
- Camunda 8 — Understanding human task management — `https://docs.camunda.io/docs/components/best-practices/architecture/understanding-human-tasks-management/`
- Camunda Best Practices — Managing the task lifecycle — `https://camunda.com/best-practices/managing-the-task-lifecycle/`

**Production human-in-the-loop primitives:**

- GitHub Actions — Reviewing deployments — `https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments`
- AWS Step Functions — Human approval tutorial — `https://docs.aws.amazon.com/step-functions/latest/dg/tutorial-human-approval.html`
- AWS Step Functions — `SendTaskHeartbeat` API reference — `https://docs.aws.amazon.com/step-functions/latest/apireference/API_SendTaskHeartbeat.html`
- Temporal — Managing very long-running workflows blog — `https://temporal.io/blog/very-long-running-workflows`
- Temporal — Workflow message passing (Python) — `https://docs.temporal.io/develop/python/message-passing`
- Temporal — Part 2: Adding durable HITL — `https://learn.temporal.io/tutorials/ai/building-durable-ai-applications/human-in-the-loop/`
- Cloudflare Workflows — `waitForEvent` HITL example — `https://developers.cloudflare.com/workflows/examples/wait-for-event/`
- Cloudflare Workflows — GA announcement (2025) — `https://blog.cloudflare.com/workflows-ga-production-ready-durable-execution/`
- LangGraph / LangChain — Human-in-the-loop docs — `https://docs.langchain.com/oss/python/langchain/human-in-the-loop`
- Microsoft Agent Framework Workflows — Human-in-the-Loop — `https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop` (updated 2026-03-31)

**Low-code UX references:**

- Zapier — Request Approval help center — `https://help.zapier.com/hc/en-us/articles/38731463206029-Request-approval-to-keep-your-workflow-running-with-Human-in-the-Loop`
- Zapier — Collect Data help center — `https://help.zapier.com/hc/en-us/articles/38731264910733-Collect-data-for-your-workflow-with-Human-in-the-Loop`
- Zapier — Human in the Loop guide blog — `https://zapier.com/blog/human-in-the-loop-guide/`
- n8n — Form Trigger node — `https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.formtrigger/`
- n8n — Community "Wait-Node with Form" thread — `https://community.n8n.io/t/wait-node-with-form-and-accessing-user-input-in-next-step/46586`
- Activepieces — Human Input / Forms piece — `https://www.activepieces.com/pieces/forms`
- Retool Workflows — product page — `https://retool.com/workflows`
- Retool — User tasks early-access forum — `https://community.retool.com/t/workflow-user-tasks-for-self-hosted-instance/51503`
- Jira Cloud — Workflow validator module — `https://developer.atlassian.com/cloud/jira/platform/modules/workflow-validator/`
- Jira Server — Make custom fields required in workflow transition — `https://support.atlassian.com/jira/kb/make-custom-fields-required-in-a-workflow-transition-in-jira-server/`

**MCP elicitation (direct precedent for `user_input` category):**

- MCP Elicitations — Standardizing interactive AI workflows (fka.dev) — `https://blog.fka.dev/blog/2025-01-15-mcp-elicitations-standardizing-interactive-ai-workflows/`
- MCP elicitation — Request user input at runtime (WorkOS) — `https://workos.com/blog/mcp-elicitation`
- FastMCP — User Elicitation server docs — `https://gofastmcp.com/servers/elicitation`
- Microsoft MCP C# SDK — Protocol 2025-06-18 update — `https://devblogs.microsoft.com/dotnet/mcp-csharp-sdk-2025-06-18-update/`
- Cisco Blogs — What's new in MCP (elicitation, structured content, OAuth) — `https://blogs.cisco.com/developer/whats-new-in-mcp-elicitation-structured-content-and-oauth-enhancements`

**Accessibility and long-form patterns:**

- W3C — WCAG 3 Working Draft (September 2025) — `https://www.w3.org/WAI/news/2025-09-04/wcag3/`
- WCAG 2.2 §3.3.7 Redundant Entry — `https://www.allaccessible.org/blog/wcag-337-redundant-entry-implementation-guide`
- Dhiwise — Implementing auto-save on forms — `https://www.dhiwise.com/post/implementing-auto-save-on-forms`

**Local repo evidence (authoritative for AI Sidekicks contracts):**

- `docs/specs/017-workflow-authoring-and-execution.md` — Spec-017 Required Behavior, Phase-Type taxonomy, State and Data Implications
- `docs/specs/012-approvals-permissions-and-trust-boundaries.md` — Spec-012 approval category enum, ApprovalResolve Cedar principal
- `docs/domain/workflow-phase-model.md` — Phase states, gate resolution results (`waiting-human`), iteration model
- `docs/backlog.md:706-713` — BL-097 Summary (guardrails 1 and 2, resolution candidates α/β/γ-i/ii/iii)
- `docs/reference/forge/contracts-desktop.md:364-368` — Forge Workflow contract: `PhaseType`, `GateAfter`, `GateResultStatus`, `AgentOutputMode`
- `docs/reference/forge/review.md:97-99, 136, 770` — Forge-side implementation precedents for Workflow phase types and human-approval gate UI

**Inferences explicitly marked in-text:**

- §3.1 "Zapier Collect Data file-upload support" — **inferred** from available public docs that describe text-only fields; the product may support richer types not in the reachable help-center pages.
- §5.1 "Cloudflare `waitForEvent` on-timeout behavior" — **inferred** (step throws / resolves null); the Cloudflare docs page describes the parameter but not exhaustively.
- §6.1 "WCAG 3 Redundant Entry draft" — **referenced as working-draft guidance**, not a ratified WCAG 2.2 criterion; track §3.3.7 of WCAG 2.2 for the current standard.

*End of Pass C.*
