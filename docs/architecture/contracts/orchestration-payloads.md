# Orchestration Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-013 — Multi-Agent Orchestration

Contracts per D-013-1..20. The Rust types live in the topic modules [Plan-013 D-013-1](../../plans/013-multi-agent-orchestration.md#design-decisions) names, `crates/sidekicks-contracts/src/orchestration.rs` among them; the generated TypeScript keeps `packages/contracts/src/orchestration.ts`. `AgentId` is a new branded UUID newtype. All mutations are daemon JSON-RPC (orchestration and agent authority is daemon-local, ADR-001/ADR-003 posture).

```ts
interface OrchestrationRunConfig {
  tokenLimit?: number; // the run's `Tokens per run`, input and output together; absent = `Unlimited`, the default (Spec-014 §Budget Policies)
}
type ChildRunProvenance = "providerSubagent" | "bridgeRun" | "workflowStep"; // D-013-12: how a child was reached — the provider's own subagent, the cross-provider bridge's `agent_run`, or a workflow's `agent.run` step (agent-definition-payloads.md §Plan-024). A `providerSubagent` link is written by the provider driver: Claude Code's subagent start and stop notifications and Codex's collaborating-agent events each add or close the run-link row for that subagent, so a provider's own subagents appear in the agent tree like any other child. Internal provenance: stored with the child's link and never drawn, so no mechanism word reaches the screen
// The reason carried on a system-initiated interrupt, the same set as agent.run.interrupted's
// `trigger`, which this set rides only. The token limit ends its run, so its `tokenLimit` rides
// agent.run.stopped's `trigger` instead.
type InterruptReason = "stepLimit" | "spendLimit" | "workflowPhaseCanceled" | "daemonRestart";

// AgentRunCreate — wire: agent.run.create (admission pipeline D-013-9:
// agent resolution -> Plan-002 queue admission; zero-residue typed refusal + durable
// agent.run.rejected on deny). No count bounds admission: the runtime sets no limit on runs,
// agents, children, nesting depth or queued messages, so a refusal here is the provider's own or a
// target that does not resolve. A reached spend limit is never a refusal: while it stands no turn
// starts in the session (Spec-014 §Budget Policies). No console
// control calls it: its callers are the daemon's own paths (the bridge's `agent_run` verb, agent-definition-payloads.md §Plan-024, and a
// workflow's run-an-agent node) and the SDK.
// The target is EITHER an agent already in the session's agents projection, or a saved
// definition with no live agent yet, which the daemon resolves at the queue insert and records as
// agent.run.queued's `resolvedAgent` (AgentRunQueuedPayload below).
type OrchestrationRunTarget =
  | { targetAgentId: AgentId } // must resolve in the agents projection (agent.notFound)
  | { targetDefinitionId: AgentDefinitionId }; // resolved at the queue insert (agent.definition.notFound / agent.definition.resolutionRefused)
type AgentRunCreateRequest = OrchestrationRunTarget & {
  sessionId: SessionId;
  parentRunId?: RunId; // present = child run; a child may create a child of its own to any depth, and no level is ever refused for being deep
  config?: OrchestrationRunConfig; // per-run override; admission resolves against session defaults and persists the merged result durably on agent.run.queued (effectiveRunConfig — D-013-5 rebuild-stable enforcement)
  clientIdempotencyKey: string; // a UUID: a resend under the same key after a reconnect answers the first run, never a second (return-or-conflict on the call's own record)
};
interface AgentRunCreateResponse {
  runId: RunId; // minted at Plan-002 queue admission (agent.run.queued); orchestration adds no second id
  state: RunState; // "queued" at create
  parentRunId?: RunId;
}

// AgentChildRunLinkList — wire: agent.childRunLink.list. A read OF the daemon's parent-to-child
// index (the paragraph after the registry below), for the WHOLE session: every child at every
// depth, whether it has a run of its own (an agent the bridge's `agent_run` started, linked in
// run_links — single-parent: `child_run_id` is the PK, so a child appears under exactly one parent;
// D-013-3) or is a provider's own helper inside its parent's run. The pane's list, the transcript's
// child rows and each child's own view all read this one source; the screen reads it again on
// agent.subagent.started, agent.subagent.completed, agent.run.queued, agent.run.rejected and each
// run state change.
// `rejectedCreates` is event-folded at read time from the session's `agent.run.rejected` events:
// zero-residue refusals (I-013-7) leave no run/queue/link row, so the fold is the only data path
// that lets the child-run view surface refusal records (events-canonical projection, the budget
// accountant's posture).
interface AgentChildRunLinkListRequest {
  sessionId: SessionId;
}
// One agent in the session's tree as the index names it: an agent with an id in the agents projection
// (the lead, or an agent the bridge's `agent_run` started), or a provider's own helper by the run it runs
// in and the handle the index minted for it. The per-agent spend and the child controls key on it.
type AgentTreeMember =
  | { kind: "agent"; agentId: AgentId }
  | { kind: "providerChild"; runId: RunId; childHandle: string };
// What a child's head reads after its name.
interface ChildRunHead {
  modelId: string;
  effort?: string; // one word from the one effort ladder
  viaAgentName?: string; // present where the child was a peer call: the agent that was asked
  tokens: number;
  spendUsdMicros: number; // integer micro-dollars, the same fold as the per-agent spend on session.budget.read
  startedAt: string;
  ancestry: AgentTreeMember[]; // from the lead down to this child's parent
}
type ChildRunLink =
  | {
      kind: "run";
      childRunId: RunId;
      parentRunId: RunId;
      agentId: AgentId;
      state: RunState;
      head: ChildRunHead;
    }
  | {
      kind: "providerChild"; // steered, interrupted and paused through the run-control child verbs by `childHandle`
      runId: RunId;
      childHandle: string;
      parentChildHandle?: string; // present when its parent is itself a provider helper
      state: RunState;
      head: ChildRunHead;
    };
interface AgentChildRunLinkListResponse {
  children: ChildRunLink[];
  // The Sidekicks badge's figures — children running now, children dispatched in all, and children
  // waiting on an approval — supplied by the daemon because the screen may hold only part of the list.
  counts: { live: number; total: number; waiting: number };
  rejectedCreates: Array<{
    parentRunId: RunId;
    targetAgentId?: AgentId;
    reason: string; // the refusing error-contracts.md code — the agent.run.create admission vocabulary spans §Agent (agent.notFound) and §Agent Run (agent.run.notFound parent reuse, D-013-11)
    detail?: string;
    occurredAt: string; // the event envelope timestamp
  }>;
}

// SessionBudgetRead — wire: session.budget.read, and the reply of session.spendLimit.update and
// session.tokensPerRun.update (D-013-5; session_budgets row-canonical). Every amount is
// integer micro-dollars (millionths of a US dollar), so small requests add up exactly; a figure is
// rounded once, where it is drawn.
interface SessionBudgetReadRequest {
  sessionId: SessionId;
}
interface SessionBudgetState {
  sessionId: SessionId;
  spendLimitUsdMicros: number | null; // the session's `Spend limit`; null = `Unlimited`, the default — one exists only where the person set it
  tokensPerRun: number | null; // the session's `Tokens per run`, input and output together for one run; null = `Unlimited`, the default
  // The ENFORCED number: what the accountant compares against spendLimitUsdMicros wherever a limit
  // is set (with spendLimitUsdMicros null nothing is compared and no turn is held for spend), and
  // the one session cost figure a surface shows — never a sum over a visible run list (Spec-014
  // §Cost Figure Display Consistency; Plan-013 I-013-15). The budget accountant folds it from the
  // persisted usage.cost.updated rows alone: each request is priced once, at completion, from the
  // live price table and never repriced, so a rebuild gives the same figure. A request on a model
  // or speed the price table does not price yet is stored with its exact tokens and no dollar
  // figure, never held back, and joins this figure when a later fetch prices it (Spec-014 §Cost
  // Derivation And Absent-Cost Semantics). Plan-013 T2.4 asserts the equality with the cost
  // receipt's total at the same fold state.
  committedSpendUsdMicros: number;
  // Spend per agent in the session's tree, the lead included, routed up the parent chain at any depth:
  // `ownUsdMicros` is what the agent's own requests cost, `subtreeUsdMicros` that plus every descendant's.
  // Folded from the same usage rows as committedSpendUsdMicros; a helper request (a reviewer, a review)
  // counts on the agent it belongs to.
  agentSpend: Array<{ agent: AgentTreeMember; ownUsdMicros: number; subtreeUsdMicros: number }>;
}

// A goal belongs to one agent in the session and is that provider's own goal: the daemon sends the
// condition as the provider's own goal command and reads each ending back from what the provider
// writes. It never emulates a goal by injecting text into prompts (Spec-014 §Session Goals).
interface SessionGoal {
  text: string; // non-blank, NUL-rejected, no length cap of the app's own: the provider refuses in its own words (persisted to the event log and handed to the provider's own goal command)
}
// The goal's status, carried on session.goal.updated. `complete` and `impossible` are terminal: a
// goal's last status is what its row draws. Only Claude Code sends `impossible`, carrying the
// judge's reason.
// Clearing is session.goal.cleared, never a status.
type SessionGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete"
  | "impossible";
interface SessionGoalUpdateRequest {
  sessionId: SessionId;
  agentId: AgentId; // the agent whose provider holds the goal
  goal: SessionGoal;
}
type SessionGoalUpdateResponse = { sessionId: SessionId; agentId: AgentId; goal: SessionGoal };
interface SessionGoalClearRequest {
  sessionId: SessionId;
  agentId: AgentId;
}
// The acknowledgment of session.goal.clear, among other session acts; clearing with no goal set
// succeeds, as Codex does.
type SessionAcknowledgment = { sessionId: SessionId };

// Agent surface (Plan-013 owns the V1 agent identity surface).
// An agent has no lifecycle state: it is in its session or it is not. An agent row is created by
// session.created (a session's lead) or agent.run.queued (an agent resolved from a saved
// definition), and its binding moves only by the binding events below, so the agents projection is
// deterministic from the log alone.
// NO WIRE VERB BRINGS AN AGENT INTO A SESSION OR TAKES ONE OUT. A session has one main agent, and
// another agent takes part only where the main one delegates to it or where the person names it in
// the composer, so there is no step that binds a saved agent to a running session and none to undo.
// The verbs here mutate and read what the session already holds. wire: agent.config.update /
// agent.subscribe The running agent's model, window, effort, output speed, session options and
// provider, each moved by the person from the composer's controls. Every member is optional and an
// omitted member is UNCHANGED, never reset. Every accepted update is a switch of the agent's
// provider binding (`AgentProviderBinding`, agent-definition-payloads.md §Plan-024) and settles
// with `agent.providerBinding.changed` or `agent.providerBinding.changeFailed`; no other event
// records it. A change of model, effort, speed or a session option alone settles in place and draws
// no transcript row.
interface AgentConfigUpdateRequest {
  agentId: AgentId;
  modelId?: string;
  // A number moves to that larger window, in tokens: the `contextWindow` of the model's larger row
  // (`ProviderModel.largerWindow`). `null` moves back to the model's default window; omitted does not
  // move it. A `modelId` move must carry it, a figure or `null`, so omitted always means unchanged.
  largerWindow?: number | null;
  // D-013-17 — the provider axis ([Spec-014 §Same-Agent Provider
  // Switch](../../specs/014-multi-agent-orchestration.md#same-agent-provider-switch)).
  // Moving this is the PROVIDER SWITCH, picked from the composer's model control, which lists every
  // installed provider's models, one heading per provider, the session's own first; it applies at
  // the end of the run in flight. Continuity is a HAND-OVER BRIEF composed on a throwaway copy of
  // the old session, never a replay of the whole conversation as text (Spec-014 §Continuity). The
  // brief starts no turn of its own: it opens the person's next message, or goes alone at the
  // switch on `interruptAndSwitch`. WHICH ACCOUNT PAYS IS NOT A MEMBER HERE: it moves on the
  // provider surface through `provider.account.current.update` (provider-account-payloads.md
  // §Plan-023), which moves every unpinned running session on that provider. A caller supplying an
  // account member is refused, not served — a per-session account switch beside a provider-wide
  // current account would let the two disagree.
  providerName?: string;
  effort?: string;
  // The output-speed axis ([Spec-014 §The mutation surface](../../specs/014-multi-agent-orchestration.md#the-mutation-surface)). Gated on the
  // target driver's `outputSpeed` capability flag, which Claude Code and Codex both declare;
  // a dispatch against a driver declaring it false refuses as provider.capability.unsupported and
  // is NEVER satisfied by moving `effort` instead, which is a different claim. Its boundary is per
  // driver: a RUN boundary on Claude Code, which takes `apply_flag_settings {fastMode}` between
  // turns with no restart and no file written, and a TURN boundary on Codex, which takes the
  // service tier on each `turn/start`; either way it settles in place like the model and the effort.
  // VALIDATED against the target model's `ProviderModel.outputSpeedLevels` where its provider
  // publishes one per model, else the target driver's declared `outputSpeedLevels`, never against a
  // list hardcoded here — the rule `effort?` above already follows. An absent or empty
  // vocabulary makes the axis unsettable and the mutation refuses `agent.providerAxisInvalid`
  // (400) fail-closed, so no unvalidated value is ever forwarded to a provider.
  outputSpeed?: string;
  // Values of the session options the TARGET driver declares (`ProviderSessionOption`,
  // agent-definition-payloads.md §Plan-024), at most one per option id; an option left out keeps
  // its value. The daemon checks each against the driver's declaration: an option the driver does
  // not declare refuses as provider.capability.unsupported, and a value outside its declaration, or
  // one the provider reports this session cannot run, as agent.providerAxisInvalid. The driver
  // carries it to its provider (Claude Code's Ultracode as `apply_flag_settings {ultracode}`); it
  // settles in place and applies from the next turn.
  options?: ProviderOptionSetting[];
  // Applies at the next boundary the TARGET AXIS permits, never at a fixed one: a turn boundary for
  // an axis the target driver takes as a per-turn override, a run boundary for a run-bound one
  // (`providerName` always, and `outputSpeed` on Claude Code — re-derived by listing, not counted). A
  // multi-axis update takes the WIDEST of its axes' boundaries, so no axis applies earlier than its
  // own rule allows. `true` dispatches the documented `interrupt` intervention
  // (`agent.run.intervene`) first and then switches — an entry point into a control the corpus
  // already has, not a new run control, so Spec-003's V1 control set is unchanged. The interrupt is
  // authorized as every intervention is, as the session's user (Spec-010 §Required Behavior), and a
  // refused interrupt refuses the switch rather than leaving the agent half-moved. This arm HOLDS
  // THE REQUEST OPEN across the boundary — which is what lets its response carry the settlement
  // below — and still writes the pending switch to the agent row BEFORE dispatching the interrupt,
  // so a crash in between costs the caller its answer and not the switch.
  interruptAndSwitch?: boolean;
}
interface AgentConfigUpdateResponse {
  agentId: AgentId;
  updatedAt: string;
  switch: AgentBindingSwitchDisposition; // every accepted update is a switch of the binding
}

// Mutation and application are TWO MOMENTS (Spec-014 §Same-Agent Provider Switch), so what the
// mutation returns is a discriminated union and not a settlement. "pending" is the ordinary
// answer; the SETTLED arms are reachable only on the interruptAndSwitch arm, which collapses
// the two moments into one by holding its request open until the switch settles (Plan-013 T2.8 is
// that arm's only producer). A caller that reads `switch.continuity` without discriminating is
// reading a member that is absent on both the common path and the "failed" arm.
//
// The disposition has the arms below because holding a request open until settlement means every settlement the boundary
// can reach must be expressible to a caller still waiting for one. "applied" and "degraded" split
// the outcome by a TOTAL and stated mapping — `applied` iff the conversation arrived whole
// (`continuity` "inPlace"), `degraded` iff it did not ("brief") — so the
// honest-degrade rule is carried by the wire's own discriminator rather than left to each client to
// re-derive from `continuity`. "failed" is the immediate arm's share of the
// `agent.providerBinding.changeFailed` terminal: an accepted switch that cannot be applied settles
// the held-open request instead of stranding it, and reuses that event's `reason` vocabulary
// verbatim — one vocabulary across both surfaces — rather than minting a second one.
type AgentBindingSwitchDisposition =
  | AgentBindingSwitchPending
  | ({ status: "applied" } & AgentBindingSwitchOutcome)
  | ({ status: "degraded" } & AgentBindingSwitchOutcome)
  | AgentBindingSwitchFailed;

interface AgentBindingSwitchPending {
  status: "pending";
  // Daemon-minted, durable on the agent row, and the correlator between this acknowledgment and
  // the terminal `agent.providerBinding.changed` / `agent.providerBinding.changeFailed` event. A
  // caller never supplies it.
  switchId: string;
  // The boundary this switch will apply at — resolved against the TARGET driver's declared
  // vocabulary, never assumed, and the widest of the moved members' individual boundaries.
  appliesAt: "turnBoundary" | "runBoundary";
  // TRUE on the interruptAndSwitch arm, FALSE on the deferred one. The boundary above says WHEN
  // the switch applies; this says whether REACHING that boundary requires an interrupt the daemon
  // must dispatch. They are independent — a deferred switch and an interrupted one can both
  // read "turnBoundary" — so neither a client nor a restarted daemon can re-derive the owed
  // interrupt from `appliesAt`, and the record has to carry it.
  interruptRequested: boolean;
  // The binding members this switch moves AND the value each is moving TO. The present keys are
  // exactly the moved members, so the boundary above stays re-derivable from it, and a client that
  // did not issue the mutation can render what the agent is switching to rather than only that it
  // is switching. Carrying the targets rather than only the member names is load-bearing for
  // durability: this same object is what the `agents.pending_switch` slot stores and what
  // `agent.subscribe` serves as `pendingSwitch`, so `switching to …` survives a reload and reaches
  // another device, and an intent recording only WHICH members moved could not be applied at the
  // boundary once the caller's request is gone.
  pendingAxes: AgentBindingSwitchTarget;
  // Present when this update REPLACED an earlier still-pending switch on the same agent: at most
  // one switch is pending per agent, and a later update supersedes rather than queues (Spec-014
  // §Same-Agent Provider Switch). The superseded id never reaches a terminal event, so surfacing it
  // here is the only record a caller gets.
  replacedSwitchId?: string;
}

// The DURABLE SLOT IS A SUPERSET OF THE WIRE SHAPE. `agents.pending_switch` stores the
// `AgentBindingSwitchPending` record above PLUS members that are never returned to a caller
// and never appended to an event payload:
//
//   the admitting device — the device whose connection carried the switch (§Authenticated Principal
//     And Authorization Model: a write records its device). Both terminals require an `actor`, and a
//     switch settling after a restart has no request left to read one from. Its one writer,
//     `agent.config.update`, is the person's own act.
//   interruptDispatch — "requested" | "dispatched", present exactly when `interruptRequested` is
//     true. Deliberately NOT a boolean and not folded into `interruptRequested`, because recovery
//     must separate "crashed before the interrupt went out, so dispatch it" from "crashed after it
//     landed, so reconcile": redispatching in the second case fires a second interrupt at a run
//     that already took one. The advance to "dispatched" is its OWN durable write, made once the
//     interrupt is accepted; a crash between the two costs one idempotent redispatch, never a lost
//     switch.
//
// Both are recovery inputs rather than session-observable facts, so they live in the durable slot
// and never in a mutation reply; keeping the slot a superset is what lets the wire shape stay
// exactly the intent a client is entitled to see.

// The immediate arm's failure settlement, carrying the SAME vocabulary as the
// `agent.providerBinding.changeFailed` event below — one vocabulary across two surfaces, so a
// held-open refusal and the terminal event render the same reason set. This is a RESULT, not a
// JSON-RPC error: the switch was accepted, a `switchId` was minted, and the pending switch was
// already recorded on the agent row, so the mutation succeeded and only the application did not.
// Refusals that happen BEFORE acceptance — an unknown axis, an invalid value — are the synchronous
// `agent.providerAxisInvalid` error instead, and mint no `switchId` and no pending switch.
interface AgentBindingSwitchFailed {
  status: "failed";
  switchId: string;
  reason: AgentBindingSwitchFailureReason;
  accountState?: AgentBindingSwitchAccountState; // present exactly when reason is "accountUnavailable"
}

type AgentBindingSwitchFailureReason =
  | "providerUnavailable"
  | "modelUnavailable"
  | "effortUnavailable"
  // The deferred application reached a target whose driver no longer declares
  // `outputSpeed`, or whose declared vocabulary no longer carries the pended value. A member of
  // its own because the axis settles at a later boundary (the next run on Claude Code, the next turn
  // on Codex) the caller has already been acknowledged for, so without it an axis-specific failure would render as one of the others and misname what
  // went wrong.
  | "outputSpeedUnavailable"
  | "interruptRefused"
  | "targetUnstartable"
  // The account the switch lands on cannot carry the run — an account move, or a provider switch
  // landing on the target provider's current account. `accountState` says why, and only
  // `reauthRequired` offers `Sign in again`. An in-place account move whose new login fails at the
  // next request settles here too, the daemon handing the previous account back.
  | "accountUnavailable";

type AgentBindingSwitchAccountState =
  | "reauthRequired" // the login expired or was refused; the one state that offers `Sign in again`
  | "homeMissing"
  | "indeterminate"
  | "notRegistered";

// The binding members a switch moves, as a partial record: an omitted key is a member this switch
// does not move. It holds no account: the account moves on the provider surface
// (`provider.account.current.update`, provider-account-payloads.md §Plan-023), in place at the next
// request, and writes no pending switch. One shape serves three surfaces — the wire acknowledgment
// above, the durable `agents.pending_switch` slot, and `agent.subscribe`'s `pendingSwitch` member —
// so a client, a projector, and a restarted daemon all read the same record of the same intent.
// An omitted key is a member not moving. The one reset is `largerWindow: null`, the move back to
// the model's default window, which is a model choice of its own rather than a cleared member.
// `providerName`, `modelId` and the account cannot be cleared at all (an agent always runs on one of
// each), and clearing `effort` or `outputSpeed` is not an operation `agent.config.update` offers,
// whose omitted members are uniformly "unchanged, never reset". `outputSpeed` is carried in this
// record rather than only at the coordinator: on Claude Code it applies at a run boundary, so it is
// a member likely to be pending across a restart, and a member a caller can request but the durable
// slot cannot hold would be acknowledged and then silently dropped.
interface AgentBindingSwitchTarget {
  providerName?: string;
  modelId?: string;
  // A number moves to that larger window in tokens, `null` back to the model's default window; a
  // `modelId` move must carry it, a figure or `null`, so omitted always means unchanged.
  largerWindow?: number | null;
  effort?: string;
  outputSpeed?: string;
  // The session options it moves, each to its value; one left out does not move.
  options?: ProviderOptionSetting[];
}

type AgentProviderAxis = keyof AgentBindingSwitchTarget;

// The settlement of a switch, carried by the `agent.providerBinding.changed` payload below.
interface AgentBindingSwitchOutcome {
  switchId: string; // correlates with the pending acknowledgment above
  // WHICH MECHANISM CARRIED THE CONVERSATION. Two different acts, not degrees of one.
  // "inPlace" = a member carried on the RUNNING process — a per-turn override, a run-bound setting
  // the provider takes without a restart, or an account moved at the next request: nothing was
  // respawned and nothing was reconstituted.
  // "brief" = a DIFFERENT provider was started from a hand-over brief: the old provider's own
  // summary taken on a throwaway copy of the session, then the current diffs and branch read from
  // disk, then every earlier step as a one-line note, then the last exchanges verbatim, then a
  // REFERENCE to the whole old transcript, which the daemon writes as one plain file beside the
  // brief for the new provider to read on demand with its own file tools. Replaying the whole
  // conversation as text is deliberately NOT what a provider switch does: the expensive thing is
  // not pushed into the message, and it is still reachable. The file is not a transcript row.
  // "inPlace" is `applied`; "brief" is `degraded` and is never
  // presented as an ordinary success. On the held-open arm that mapping is carried by the
  // disposition's own `status` discriminator above, so a client never re-derives it; on the terminal
  // event it is carried by this member alone, the event having no status.
  continuity: "inPlace" | "brief";
  // REQUIRED, and an EMPTY ARRAY IS A CLAIM: it asserts that nothing was dropped. A driver that
  // does not know what it lost may not emit one. A loss is a `DeclaredLossKind`,
  // never a free string. Requiredness is scoped to the continuity arm: "inPlace" MUST carry the
  // empty array (nothing was reconstituted, so no loss could occur), and "brief" MUST be non-empty
  // and MUST include "conversationHistorySummarized" together with "providerPrivateReasoning".
  // The claim is scoped to TRANSCRIPT CONTENT and to nothing else. An empty array
  // asserts that the conversation arrived intact; it asserts nothing about whether a requested
  // provider SETTING took effect on the new binding. Those are different facts with different
  // carriers — a speed setting the provider declined is reported by the live read-back on the
  // agent row, not by a loss kind — and conflating them would either fabricate a transcript loss
  // that did not happen or let an empty array be read as a guarantee it was never making.
  declaredLosses: DeclaredLossKind[];
}

type DeclaredLossKind =
  | "providerPrivateReasoning" // non-portable by both vendors' stated rules; never translated. ALWAYS present on a "brief" settlement
  | "contextTruncated" // only the last exchanges travel verbatim, so older ones did not (whole exchanges only, never halves)
  | "toolCallHistoryRepaired" // an unpaired call took a synthetic error result rather than being dropped
  | "conversationHistorySummarized" // the brief's own summary stood in for the conversation the new provider cannot read
  | "helperConversations" // the old provider's helper conversations under this session; their conclusions survive in the transcript, the conversations themselves do not
  | "toolOutputBodies" // earlier steps travel as one-line notes, so the bodies of their output do not. Files touched on disk are unchanged
  | "liveToolCalls" // tool calls arrive as history and never as work in flight; a call that was about to run does not run
  | "providerSkillAndCommandNames" // the old provider's own skills and commands name nothing on the new one
  | "turnContentUnavailable"; // a logged turn's body could not be read when the fold ran; the turn is carried with its structural position and an empty body rather than being dropped, because an empty body alone reads as "the author said nothing" and a dropped turn reads as "the turn never happened" and both are false. Produced by the fold, which is daemon-side and upstream of the driver: it reaches AgentBindingSwitchOutcome.declaredLosses through the canonical projection

// agent.providerBinding.changed — a switch landed (Spec-005 §Agent Lifecycle). A change
// of model, effort or speed alone settles `inPlace` with no declared losses and draws no transcript
// row; a provider switch or an account switch draws the switch row: the binding it left and the one
// it is on, the account the run landed on, how the conversation continued, and what did not carry
// over.
interface AgentProviderBindingChangedPayload extends AgentBindingSwitchOutcome {
  sessionId: SessionId;
  agentId: AgentId;
  actor: string; // the admitting device recorded on the pending switch
  from: AgentProviderBinding; // the binding the agent left, its account included
  to: AgentProviderBinding; // the binding it is on now; `providerAccountId` null where it follows the provider's current account
  // The account the run actually landed on, separate from `to.providerAccountId`, so an agent that
  // follows the current account is never silently pinned to the account it happened to land on.
  landedProviderAccountId: ProviderAccountId;
}

// agent.providerBinding.changeFailed — a switch accepted as pending could not be applied, and the
// agent stays on the binding it had: the previous provider and account stay active, no success row is
// drawn, and the transcript gains one system message naming the attempted switch and the reason, with
// `Sign in again` only where `accountState` is `reauthRequired`. Emitted on BOTH arms whenever an
// accepted switch fails at application: the pending slot is cleared by a terminal and never by a
// reply, so the immediate arm additionally settles its held-open request as the `failed` disposition.
// Exactly one of the binding events terminates every pending switch that is not superseded.
interface AgentProviderBindingChangeFailedPayload {
  sessionId: SessionId;
  agentId: AgentId;
  switchId: string;
  actor: string;
  from: AgentProviderBinding; // the binding it stayed on
  attempted: AgentBindingSwitchTarget; // the members the switch tried to move, the account included
  reason: AgentBindingSwitchFailureReason;
  accountState?: AgentBindingSwitchAccountState; // present exactly when reason is "accountUnavailable"
}

// agent.subscribe — a LIVE list: the session's agents, then each agent row again as it changes,
// like session.subscribe, so a switch in flight and its settlement reach every window and device.
interface AgentSubscribeRequest {
  sessionId: SessionId;
}
interface AgentSubscribeResponse {
  agents: AgentListEntry[];
}
// One session option as the provider reports it on a live binding (ProviderOptionSetting,
// agent-definition-payloads.md §Plan-024, plus whether this session can run it).
interface ObservedProviderOption {
  id: string;
  value: boolean | string; // the value in effect
  isAvailable: boolean; // whether this session can run it; an option it cannot run is not drawn
}
interface AgentListEntry {
  agentId: AgentId;
  name: string;
  // D-013-17: the agent's EFFECTIVE binding — the one it runs under now, never the pending one.
  // `providerAccountId` null = the agent follows the provider's current account (the one marked
  // `Default`); `effort` null = the driver's own default for the model; an absent `outputSpeed`, or
  // an option absent from `options`, was never set, so the provider's own value stands; absent
  // `largerWindow` = the model's default window.
  // Each member is served from its own column on the agent row, the columns an applying switch
  // commits into, so every member a switch can move is read back here once it applies; a run-bound
  // member readable only as a PENDING intent would go dark then.
  binding: AgentProviderBinding;
  // What the PROVIDER declared, as against `binding.outputSpeed`, which is what was REQUESTED
  // (Spec-004 §The output-speed axis). Projected at response-build time from the
  // binding-held `ProviderOutputSpeedState` — the observation the driver recorded when the
  // provider's latest declaration arrived — and stored in no column, so it cannot go stale. LIVE-SCOPED on
  // the SA-41 wait-member precedent.
  //
  // ABSENT HAS THESE CAUSES, and none of them is "the mode is off": the binding's driver declares
  // no `outputSpeed` and there is nothing to read; or no binding for this agent is live, and a
  // binding that is not live has no observation — a live one carries it from spawn or
  // establishment onward. Presence is the discriminator for "this was read from the provider";
  // absence is never read as "off" and never stands in for `binding.outputSpeed`. The speed control
  // reads only its value, with no second state beside it.
  //
  // An agent runs on one binding at a time, so the projection is that binding's declaration. This
  // member is what makes the prohibited false success unrenderable: a provider that ACCEPTS the
  // setting and then declares the mode off for a run that asked for it lands one
  // `fastOutputUnavailable` notice, drawn as the flow row whose words
  // [Spec-021 §Session Composer](../../specs/021-desktop-app-and-renderer.md#session-composer--the-chrome-every-session-view-carries--plan-020-desktop-app-and-renderer)
  // holds, and the speed control reads `Standard` until the provider declares it on.
  // That disagreement is deliberately NOT a switch failure: the switch applied, the provider
  // then declared something else, and reporting it as a failure would be the same false claim
  // in the other direction — so `AgentBindingSwitchFailed.reason` stays unwidened for it, and
  // `outputSpeedUnavailable` keeps its own narrower meaning (the mode could not be requested
  // at all: the vocabulary is gone, or the target driver stopped declaring the flag).
  observedOutputSpeed?: ProviderOutputSpeedState;
  // The session options as the provider reports them on the live binding, read after each spawn
  // and each change: the value in effect and whether this session can run it, at most one per
  // option id (Claude Code's Ultracode from `get_settings`' `applied.ultracode` and
  // `applied.ultracodeAvailable`). The effort control's option rows and its `<effort> · <label>`
  // read this, never `binding.options`, and an option this session cannot run is not drawn.
  // Absent where no binding for this agent is live or its driver declares no session option, as
  // `observedOutputSpeed` is; absence is never read as "off".
  observedOptions?: ObservedProviderOption[];
  // Present exactly while a switch is pending on this agent, so the deferred intent is readable
  // rather than inferable — including after a daemon restart, which re-arms it from the durable
  // agent row. A live list is how a caller that was not the mutator learns a switch is queued.
  pendingSwitch?: AgentBindingSwitchPending;
  // Present iff this agent was resolved from a saved definition — the row a name in a composer
  // produces. Every field as actually applied, with the resolved binding in place of the folded axes
  // (agent-definition-payloads.md §Plan-024). It is a record of what the run started under, never a live view of the definition: the
  // definition may have moved since, and the agent keeps what it was given. Its
  // `resolvedFromDefinitionId` is the one home of the definition an agent came from.
  resolvedConfiguration?: AgentResolvedConfiguration;
  // Where the agent sits in the session's tree: from the lead down to this agent's parent, read
  // from the daemon's parent-to-child index (the same source as agent.childRunLink.list's
  // `ancestry`); empty for the lead.
  ancestry: AgentTreeMember[];
  createdAt: string;
}

// agent.run.queued payload (Spec-005 §Run Lifecycle): a run's creation, and the one durable record
// of how it came to be. The linkage members ride a run another run or a workflow created, on this
// row only and never on the run's state stream; an orchestration-created child's run_links row and
// its per-run limits rebuild from this event alone, while a provider's own subagent's row is
// written by the provider driver from that provider's subagent notifications. `effectiveRunConfig`
// is the admission-resolved OrchestrationRunConfig (request override else session default), kept so
// the token-limit enforcement rebuilds the same even if session defaults change mid-run (D-013-5).
//
// Every run names its agent exactly ONE way: `agentId` for an agent already in the projection (the
// lead's own run names the session's lead, the `mainAgent` of its `session.created`, this way), or
// `resolvedAgent` where the request that created the run named a saved definition instead — a peer
// invocation's own run included. `resolvedAgent` is the CREATING RECORD of that agent's row, in the
// one shape `agent.subscribe` describes an agent: `session.created` mints a session's lead and this
// member mints an agent resolved from a definition, and no event of the agent itself creates a row.
// Its `resolvedConfiguration` is present, and that configuration's `resolvedFromDefinitionId` names
// the definition. Path-independent, like the admission stamps: the daemon mints the agent's id at
// the queue insert exactly as it mints the run id, whichever creation path admitted the run.
type AgentRunQueuedPayload = {
  sessionId: SessionId;
  runId: RunId;
  runVersion: number;
  newState: "queued";
  parentRunId?: RunId;
  reachedBy?: ChildRunProvenance; // present with parentRunId: how the child was reached
  isApart?: true; // a turn in a process of its own, such as Claude Code's staged review; never the lead run
  effectiveRunConfig?: OrchestrationRunConfig;
  // ── Path-independent admission stamps: agent.run.queued carries them for EVERY provider run,
  // whether admitted via the ordinary agent.queueItem.create path or orchestration admission (the
  // orchestration path threads their values through the OrchestrationRunLinkCarrier; the ordinary
  // path stamps directly at the queue write — CP-002-10 owns the stamps either way). Never
  // client-suppliable, and never on the run's state stream.
  // As-of-admission model family, frozen here for every admitted provider run: orchestration-
  // created runs resolve agentId → agent model → pricing-family key; ordinary runs resolve from the
  // admission-resolved provider model. Derived pricing keys off it; a later agent.config.update
  // model change never re-keys an admitted run, and a rebuild reads this field, never the current
  // agents projection. Derived pricing resolves per usage row: a row wire-attributed to another
  // model (e.g. a differently-modeled subagent) keys off that model's family; this field is the
  // fallback when the wire carries no attribution.
  admittedModelFamily?: string;
  // The account the run was admitted against. Priced usage rows join to a paying account through the run,
  // and resume rebinds to this stamp rather than re-resolving the current default. Every run has one:
  // admission refuses a provider with no account to run on.
  admittedProviderAccountId: ProviderAccountId;
} & (
  | { agentId: AgentId; resolvedAgent?: never }
  | {
      agentId?: never;
      resolvedAgent: AgentListEntry & { resolvedConfiguration: AgentResolvedConfiguration };
    }
);

// Orchestration queue-admission carrier (D-013-9) — IN-PROCESS seam type, not a wire shape,
// declared in `crates/sidekicks-daemon/src/orchestration/` and never in
// `crates/sidekicks-contracts`: the orchestration-run-service passes it to Plan-002's daemon
// queue-admission service after its own admission pipeline passes; the agent.run.queued event
// payload then carries these fields durably (Spec-005 §Run Lifecycle agent.run.queued row —
// additive optional fields). The wire agent.queueItem.create handler never populates it — child-run
// creation goes through agent.run.create only.
interface OrchestrationRunLinkCarrier {
  parentRunId?: RunId;
  reachedBy?: ChildRunProvenance; // present with parentRunId: how the child was reached
  agentId: AgentId; // the resolved target (CP-002-10): the wire's targetAgentId, written to agent.run.queued as `agentId`, or the agent minted from its targetDefinitionId, written as `resolvedAgent`
  effectiveRunConfig: OrchestrationRunConfig; // admission-resolved post-merge values (request override else session default), persisted on agent.run.queued so the token-limit enforcement is rebuild-stable (D-013-5)
}
```

**Method-string registry — Plan-013** (daemon JSON-RPC; procedure types per [API Payload Contracts §Procedure Types](./api-payload-contracts.md#procedure-types)):

| Method | Procedure type | Request → Response | Notes |
| --- | --- | --- | --- |
| `agent.run.create` | `mutation` | `AgentRunCreateRequest` → `AgentRunCreateResponse` | Admission pipeline; composes with Plan-002 queue admission in-process |
| `agent.childRunLink.list` | `query` | `AgentChildRunLinkListRequest` → `AgentChildRunLinkListResponse` | A read of the daemon's parent-to-child index for the whole session: both kinds of child, their head facts, the badge counts, and event-folded `rejectedCreates` (zero-residue refusals, I-013-7) |
| `session.budget.read` | `query` | `SessionBudgetReadRequest` → `SessionBudgetState` | Committed spend and the per-agent spend, in micro-dollars |
| `session.costReceipt.read` | `query` | `SessionCostReceiptReadRequest` → `SessionCostReceipt` | Read-only decomposition of the committed-spend fold (D-013-16 — shapes below); served from the same accountant accessor as `session.budget.read`, so the two can never disagree |
| `session.goal.update` | `mutation` | `SessionGoalUpdateRequest` → `SessionGoalUpdateResponse` | [Spec-014 §Session Goals](../../specs/014-multi-agent-orchestration.md#session-goals); an accepted update emits `session.goal.updated` carrying the same canonical `goal` |
| `session.goal.clear` | `mutation` | `SessionGoalClearRequest` → `SessionAcknowledgment` | An accepted clear emits `session.goal.cleared` (clearing is the distinct operation — an update without a goal is malformed) |
| `agent.config.update` | `mutation` | `AgentConfigUpdateRequest` → `AgentConfigUpdateResponse` | The running agent's model, window, effort, speed, session options and provider; never the account, which is `provider.account.current.update` (provider-account-payloads.md §Plan-023). Settles with `agent.providerBinding.changed` or `agent.providerBinding.changeFailed` |
| `agent.subscribe` | `subscription` | `AgentSubscribeRequest` → `AgentSubscribeResponse` | Agents-table projection, live: the list, then each change |
| `provider.terminalSession.list` | `query` | `EmptyPayload` → `ProviderTerminalSessionListResponse` | The provider sessions typed in a terminal, each a `TerminalProviderSession` with its `provider`; shapes in local-ipc-payloads.md §Plan-005; empty while `Reach Codex sessions started in a terminal` is off |

`session.maxSteps.update`, `session.spendLimit.update` and `session.tokensPerRun.update`, the session's own `Max steps per turn`, `Spend limit` and `Tokens per run`, are registered with their shapes in session-payloads.md §Session Method-Name Registry.

**The session tools mint no method here, and that is the point.** Sessions find, read, message, start, ask, wait on, stop and organize each other through the twelve tools the daemon serves to the **providers** — `session_list`, `session_search`, `session_options`, `session_read`, `session_start`, `session_send {to, message, files?, wait?}`, `session_ask`, `session_wait`, `session_stop`, `session_update`, `session_group` and, on Codex only, `session_remind` — whose arguments the daemon parses where the call reaches it, served on the daemon's shared `sidekicks` MCP tool server, an in-process server named in Claude Code's `initialize` and every `mcp_set_servers` set and one `url` entry per session on Codex — never a Codex dynamic tool — so a call arrives at the daemon as that provider's own MCP tool call and is answered there ([Spec-014 §Session Tool Texts](../../specs/014-multi-agent-orchestration.md#session-tool-texts)). A call is an ordinary tool call under the calling session's own permission level — the levels that ask raise the ordinary approval card, `Sandboxed` and `YOLO` ask nothing, and no switch, setting or cap of the app's gates it — and what a message causes follows the receiving session's own level. The name a model reads is the server's name plus the tool — `mcp__sidekicks__session_send` on Claude Code, `mcp__sidekicks.session_send` on Codex. `to` is the other session's name or id and the daemon resolves the address from its own directory, so no caller spells one; a name two sessions share is refused with both listed by id and project. `wait: true` returns the answer in the same call. `files` is an optional list of paths the sending session can read, which the daemon stages into the receiving session as attachments through [Spec-012](../../specs/012-artifacts-files-and-attachments.md)'s ingest pipeline, so they arrive as paths the receiving model reads with its own file tools on every provider rather than as bytes on this tool's own wire — both `SessionSend` rows carry the file chips a sent turn's attachments already carry, and the only bound on them is that pipeline's. The daemon reads each of those paths **as the person's own user, at send time**, and a path that does not exist or cannot be read **fails the call with that path named in the tool result** rather than being dropped from the list while the rest arrive; there is no second gate on top of that read, since the receiving session runs as the same person on the same machine and could open the path itself. No client calls them, so no wire method is registered, no error code is minted, and no event type is added: a send's result carries one state at a time — `sent`, then `delivered`, `queued`, `held`, `refused` with the provider's own reason, or `notDelivered` — and a refusal is the provider's own words rather than this corpus's error envelope. What the screen draws rides documented surfaces. The two rows are the ordinary tool events of the two sessions' logs, and a sent row's later states come over the run-state subscription. The exchange line on a session's row is the `exchange` member (`{peerSessionId, peerName, messageCount}`) of that session's `session.subscribe` entry ([§Plan-001](./session-payloads.md#plan-001--session-core)), present while the session trades messages, so one feed serves every row and the list opens no stream per session. The messages waiting for a paused session are items of that session's own queue, held in arrival order with the sending session as their origin and read through `agent.queueItem.list` ([§Run-Control Method-Name Registry](./run-control-payloads.md#run-control-method-name-registry)). The daemon's phone book of sessions and addresses and its exchange table are daemon-interior and reach no wire; beside the exchange line, the one member a client reads is `addresses` on `SessionRecord` (session-payloads.md §Plan-001), one per place, which the inspector's `Copy address` lifts.

**The daemon's own agent tree, and why no verb reads it directly.** The daemon builds a parent-to-child index per session FROM THE PROVIDER STREAM — the task-started frame and its parent call id on Claude Code, the child's turn-started frame on Codex — and persists it, because neither Claude Code nor Codex lists its children back on a resume. That index is the single source of every fan-out count the screen shows and of every stop that reaches more than one child: a subtree stop is one stop per id walked from the index at every depth, never a relay through the lead, because neither Claude Code's lead nor Codex's can stop a subtree — Claude Code's own stop tool refuses a grandchild as another agent's, and Codex has no stop-all verb at all. The durable handle for a child is the run plus the provider plus the child together, never a bare child id, which is what lets a restart re-attach every child by id. Four further things the index holds are daemon-interior and reach no wire: the per-child hold key that routes a pause to the right leg, the background request issued before a lead interrupt on one provider so a foreground child is not swept with it, the per-child stop behind the two sweeping controls, and the provider's own terminal verbs that end a command an interrupt left running. `agent.childRunLink.list` above is the projection a client reads; it is a read OF the index, and no second verb exposes the index itself. The two child records the screen folds are `agent.subagent.started` and `agent.subagent.completed`, whose taxonomy is [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md)'s.

Error vocabulary: [error-contracts.md](./error-contracts.md) §Agent and §Agent Run (D-013-11), plus `provider.capability.unsupported` for a switch axis the target driver does not have, and for the goal RPCs `session.notFound` for a session id the daemon does not hold, appending nothing, and `provider.capability.unsupported` where the agent's provider cannot carry a goal. Durable events owned by Plan-013 (Spec-005 registrations): `agent.providerBinding.changed` / `agent.providerBinding.changeFailed` (payloads above), `agent.run.rejected`, `session.spendLimit.reached` and `agent.run.tokenLimit.reached` (a limit the person set, reached), `session.goal.updated` / `session.goal.cleared` (emitted by the goal RPCs above) — see [Spec-005 §Event Type Enumeration](../../specs/005-session-event-taxonomy-and-audit-log.md#event-type-enumeration). `approval.reviewer.flagged` is not Plan-013's: the Codex normalizer emits it ([Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.33).

**Session cost receipt (Plan-013 D-013-16).** One read pair, `session.costReceipt.read {sessionId}`, which refuses a session id the daemon does not hold with `session.notFound` and appends nothing. The reply is a **decomposition of the committed-spend fold**, not a second computation: every figure is served from the same accountant accessor that answers `session.budget.read`, so a divergence between the two is a bug in exactly one place. It answers the providers in the order the session first spent on them, the session's own provider first, each with one row per account that provider spent on, its `Voice` row where the session made voice calls, and a subtotal the daemon computes, then the session total. Every amount is integer micro-dollars. Read-only — no receipt member is accepted on any request, so a caller can never assert an attribution or a total.

```ts
interface SessionCostReceiptReadRequest {
  sessionId: SessionId;
}

// The partition identity below is the contract, not commentary. Each unit of committed spend appears
// in EXACTLY ONE row, so each provider's account rows, its voice row included, sum to its subtotal,
// and the subtotals sum to the session figure:
//   sum(providers[].subtotalUsdMicros) === sessionTotal.committedSpendUsdMicros
// A consumer asserting it is asserting that no row was double-counted or dropped.
interface SessionCostReceipt {
  sessionTotal: SessionBudgetState; // the SAME shape the budget read/update replies carry — one type, one accessor
  // In the order the session first spent on each provider, the session's own provider first. The
  // receipt has no per-run lines.
  providers: SessionCostReceiptProvider[];
}

// One provider the session spent on.
interface SessionCostReceiptProvider {
  providerName: ProviderId; // the provider, as on an agent's binding
  accounts: SessionCostReceiptAccountRow[]; // one row per account this provider spent on
  voice?: SessionCostReceiptVoiceRow; // the `Voice` row, present where the session made voice calls on this provider
  subtotalUsdMicros: number; // computed by the daemon: the account rows plus the voice row
}

// One provider account's spend: its tokens and its dollars.
interface SessionCostReceiptAccountRow {
  providerAccountId: ProviderAccountId;
  billingMode: BillingMode; // subscription | metered | unknown (provider-account-payloads.md §Plan-023's BillingMode); labels the figure and never changes how it is derived; `unknown` is never presented as billed dollars
  tokens: number;
  usdMicros: number;
}

// A provider's voice calls: their length and their cost at the voice model's price.
interface SessionCostReceiptVoiceRow {
  seconds: number;
  usdMicros: number;
}
```

The receipt mints no event type, no error code and no table: it is a decomposition of the budget accountant's in-memory fold over the `usage.cost.updated` rows, including the rows written for requests priced from a provider's own telemetry export. The account each row names comes from the per-turn usage rows, keyed on the account each request ran on; the row carries that account's id and billing mode, and its name is the one Plan-023 supplies for that id ([Plan-023](../../plans/023-provider-accounts-and-credential-homes.md), CP-023-3); a turn split across two accounts by an account switch lands as two rows, so the rows still sum to the session total.
