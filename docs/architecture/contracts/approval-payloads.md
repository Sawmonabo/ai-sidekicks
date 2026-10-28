# Approval Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-009 — Approvals Permissions And Trust Boundaries

```ts
// Plan-009 shapes (D-009-1/D-009-3) — the Rust types live in
// crates/sidekicks-contracts/src/approval.rs; the generated TypeScript keeps
// packages/contracts/src/approval.ts. PermissionCheck, whose two shapes live in the daemon
// (`crates/sidekicks-policy/src/`, beside the permission check), is a daemon-internal API
// (Spec-010: "inside the local daemon"); it has no JSON-RPC method string and no SDK surface in V1
// (D-009-5; the in-process check is the composed enforcement gate per D-009-18 — evaluate, then on
// an ask-policy outcome create the request via the approval service (whose create persists and
// emits `approval.requested` — the single emission seam), and notify the run-blocking seam before
// returning).

// → api-payload-contracts.md §Branded ID Types
type RememberedRuleId = string & { readonly __brand: "RememberedRuleId" };

// The rule an approval hands to the provider — explicit enum, not free-form (Spec-010 §Interfaces
// And Contracts). `request_only` (Spec-010 §Default Behavior) is expressed by OMITTING
// rememberedScope, never by an enum member. The subject is the one the daemon derived from the ask
// and the card displayed (D-009-10): a command's program and first subcommand; a network request's
// host; a written file's name. The provider keeps the rule and answers by it, at every level that
// asks; the daemon keeps no rule store, and the session's own answers are its record.
interface RememberedScope {
  // 'session' = the provider's session rule, which the card's middle button makes by being pressed:
  // Claude Code's session flag settings (`apply_flag_settings {permissions}`, each call carrying
  // the whole allow and deny lists and, at Reviewed, `ask: ["Bash(rm *)"]`), Codex's
  // `acceptForSession`. 'project' = the provider's project rule file, which the same button's own
  // arm writes: Claude Code's `.claude/settings.local.json` through the answer's `destination:
  // "localSettings"`, Codex's `.codex/rules/sidekicks.rules`, written by the daemon and listed in
  // the repository's `.git/info/exclude`.
  kind: "session" | "project";
  // the subject the daemon derived from the ask and the card displayed; re-derived at resolve, and
  // an echoed pattern that differs is refused
  pattern: string;
  // Allow or block. A block is the `networkAccess` decline's own rule — the host is refused with NO
  // card raised until the rule is replaced — so the rule set is two-sided and a decline is not
  // merely the absence of a grant. REQUIRED rather than defaulted: a missing sense would have to
  // read as `allow`, and a silently-widened block is the one reading a permission rule must never
  // take.
  sense: "allow" | "block";
}

// Why a rule ended: the person revoked it, its session (the provider's own session) ended, or the
// tool server whose tool it covers was removed. A project's rules live in the project's own folder
// and stay with it.
type InvalidationTrigger = "explicit" | "sessionEnd" | "serverRemoved";

// approvalFlow event payloads for six of the `approval.*` types — `requested`, `approved`,
// `rejected`, `canceled`, `rule.remembered`, `rule.revoked` (Spec-005 §Approval Flow; mirror of the
// Rust types in `crates/sidekicks-contracts/src/approval.rs`, one per type, each
// `deny_unknown_fields`). The payloads carry the projection-rebuild fields (D-009-6 rebuild;
// D-009-7 events-canonical): `requested` carries the request fields; the resolution events carry
// the answering device and the effective scope; `remembered` carries the rule the answer handed to
// the provider (binding = `rememberedScope`, origin resolution via `approvalRequestId`), the
// session's own record of it, which the daemon lists and carries across a restart of the provider's
// process; decision and state ride the event type; envelope timestamps supply the created/updated
// instants. Each type's schema requires exactly its own members, so a malformed event fails at the
// emission parse, never at restart projection (I-009-9). The other members of the same category
// have payloads of their own: `approval.reviewer.flagged`, `approval.reviewer.denied` and
// `approval.denial.overridden`, see their payloads below, and the `plan.*` types, whose records are
// §The plan verdict's.
interface ApprovalRequestedPayload {
  sessionId: SessionId;
  runId: RunId;
  approvalRequestId: ApprovalRequestId;
  category: ApprovalCategory;
  scope: string;
  // recorded requester actor (the agent's actor id, or the device a person's request came from,
  // Spec-010 §Required Behavior)
  requestedBy: string;
  // audit-grade target (Spec-010 §Interfaces And Contracts); on a provider permission ask it also
  // holds the ask's tool name and the provider's own prompt text, where sent
  resourceDescriptor: Record<string, unknown>;
  // present when the request originates from a provider permission ask (Claude Code's can_use_tool
  // for any tool but its question tool, or a Codex approval request), which it records once: the
  // daemon's own id for the ask, a UUIDv7 (the provider's request id is delivery routing state,
  // never this id), persisted at creation as the durable ask↔approval association — a restart's
  // rebuild reconstructs which native ask an outcome must answer when several asks are in flight on
  // one run, so the answer reaches the provider across a restart; its presence is required at the
  // CP-009-5 normalizer emission seam (T2.8 — the sole requester a provider ask originates), since
  // the schema cannot know whether a request came from a provider ask; set only by the daemon's
  // in-process create from a provider ask, and never supplied by a client; persisted on the
  // approval_requests projection row (ask_id — local-sqlite-schema.md §Approval Tables)
  askId?: string;
  // present when the ask holds a tool call: that call's id, Claude Code's `tool_use_id` on
  // `can_use_tool` or Codex's `itemId` on its approval request, the same id the call's Tool
  // Activity rows carry as `payload.toolCallId` (Spec-005 §Tool Activity), so that row draws its
  // held mark and `Declined`; bounded as those rows bound it
  toolCallId?: string;
}
// approval.approved and approval.rejected
interface ApprovalResolvedPayload {
  sessionId: SessionId;
  runId: RunId;
  approvalRequestId: ApprovalRequestId;
  category: ApprovalCategory;
  scope: string;
  effectiveScope: string; // recorded effective scope (≤ requested, I-009-6)
  // the answering device's id, the device whose connection carried the answer; a card answered
  // elsewhere reads it as `Answered on <device>`
  deviceId: DeviceId;
  // the resolving request's own `clientResolutionId`, echoed so the device whose answer landed
  // knows it did
  clientResolutionId: string;
  // the rule the person asked to keep with the answer, so a rebuild and a resend record the rule
  // asked for even when `approval.rule.remembered` was never written
  rememberedScope?: RememberedScope;
  // on `approval.rejected` only, the words the person typed on `Decline`'s optional line, which go
  // back to the agent, so a resend and a rebuild hand and restore the words the answer carried
  declineReason?: string;
  // on `approval.approved` only, the command or path the person corrected on the card: the one
  // action the approval covers, which the permission check lets run once, on the card's own run
  // (local-sqlite-schema.md §Approval Tables)
  editedAction?: string;
}
interface ApprovalCanceledPayload {
  sessionId: SessionId;
  runId: RunId;
  approvalRequestId: ApprovalRequestId;
  category: ApprovalCategory;
  scope: string;
}
interface ApprovalRuleRememberedPayload {
  sessionId: SessionId;
  runId: RunId;
  approvalRequestId: ApprovalRequestId;
  category: ApprovalCategory;
  scope: string;
  machineId: MachineId; // the machine whose provider keeps the rule
  ruleId: RememberedRuleId;
  rememberedScope: RememberedScope;
}
interface ApprovalRuleRevokedPayload {
  sessionId: SessionId;
  category: ApprovalCategory;
  scope: string;
  ruleId: RememberedRuleId;
  invalidationTrigger: InvalidationTrigger;
  // absent where no ask was in flight, as when a project is detached or a tool server is removed
  runId?: RunId;
  approvalRequestId?: ApprovalRequestId; // ditto
}

// approval.reviewer.flagged payload — an `approvalFlow` event with its own shape
// (Spec-005 §Approval Flow registry row). A warning or a required review from Codex's own
// reviewer at the `reviewed` level, which the flow draws as one system message with no control,
// in the words `text` carries. The Codex driver's event normalizer emits it (Plan-003 T3.33) from
// those Codex signals; Codex's per-turn moderation metadata, a display hint with no words,
// is never this event and stays in the daemon's log. Claude Code sends no such signal.
interface ApprovalReviewerFlaggedPayload {
  sessionId: SessionId;
  runId: RunId;
  agentId: AgentId;
  // Required; always resolves to the event of the approval request or tool call Codex's reviewer
  // holds.
  eventId: string;
  // `reviewWarning`: a `guardianWarning`, drawn `Review warning · <text>`. The normalizer pairs
  // each warning with the review Codex completes right after it and records none for a warning that
  // reports an approval, or for one about an action the reviewer blocked, whose words are on that
  // action's own row (`approval.reviewer.denied`). `reviewRequired`: an
  // `autoApprovalReview/strictReviewRequired`, drawn `Review required · <text>`.
  signal: "reviewWarning" | "reviewRequired";
  // The words the row shows. For a warning, Codex's sentence exactly as Codex sent it. A required
  // review carries no words, so its text is the sentence Codex's own app writes for it:
  // "This request requires additional safety checks, some tool calls might take extra time".
  text: string;
}

// A daemon-minted identifier for one block by the provider's own reviewer. It is stable across a
// restart and across the person's devices, so a press on any screen names the same block.
type DenialId = string & { readonly __brand: "DenialId" };

// approval.reviewer.denied payload — an `approvalFlow` event with its own shape (Spec-005
// §Approval Flow registry row). At the `reviewed` level the provider's own reviewer blocked one
// action —
// Claude Code's auto-mode classifier, captured by its `PermissionDenied` hook and the result's
// `permission_denials`; Codex's automatic reviewer, captured from
// `item/autoApprovalReview/completed`. The blocked call keeps its row in the flow, a failed row
// on which each block is its own reason line, `Blocked · <reason>`, with its own button,
// `Allow once`, wherever `overridable` is true; a block that names no call is a row of its own
// with the same line and button. The daemon keeps the provider's own denial with this record —
// Claude Code's action as the hook received it, Codex's review as Codex sent it — so an override
// still works after a restart; it never rides the payload.
interface ApprovalReviewerDeniedPayload {
  sessionId: SessionId;
  runId: RunId;
  agentId: AgentId;
  denialId: DenialId;
  // The event of the blocked call, whose row carries the reason line and the button. Absent on a
  // block that names no call — Codex's review of a network request — which is a row of its own,
  // recorded as it arrives, its reason `network access to <target> · <Codex's rationale>`.
  eventId?: string;
  // The reviewer's reason in the provider's own words: Claude Code's denial reason, such as
  // `[Data Exfiltration]`; Codex's review rationale. Absent where the reviewer gave none, and the
  // row then reads `Blocked` alone.
  reason?: string;
  // False where the provider lets no person overrule the block — Claude Code's block without a
  // classifier verdict, and Codex's review that timed out — and the row then carries no button.
  overridable: boolean;
}

// approval.denial.overridden payload — an `approvalFlow` event with its own shape. The person
// pressed `Allow once` and the agent was told it may try that one action again; the row reads
// `Allowed once` and the button goes on every screen. The agent decides whether to retry, and
// nothing runs by itself.
interface ApprovalDenialOverriddenPayload {
  sessionId: SessionId;
  denialId: DenialId;
}
// `approval.resolve`
interface ApprovalResolveRequest {
  approvalRequestId: ApprovalRequestId;
  decision: ApprovalDecision;
  // granted scope; defaults server-side to the request's scope; never broader than requested
  effectiveScope?: string;
  // The rule this resolution hands to the provider, absent for a one-time answer. Its `sense` must
  // agree with `decision` — an `approved` resolution mints an `allow`, a `rejected` one a `block` —
  // and the pair is schema-refined, so a decline cannot mint a grant. A block is reachable only
  // from the `networkAccess` category, which is the one ask whose decline has a subject worth
  // blocking. `pattern` carries the DERIVED SUBJECT the card's own button displayed: for a command,
  // the program and its first subcommand; for a network request, the host; for a file write, the
  // file's name. The daemon derives it from the ask and the client echoes what it showed, so the
  // rule can never cover more than the words the person pressed.
  rememberedScope?: RememberedScope;
  // What the person typed on `Decline`'s one optional line, sent to the agent through the
  // provider's own refusal field, or, on a request the daemon raised itself, handed to the code
  // that raised it (a workflow command step keeps it with the step's failure); absent sends a bare
  // decline. Only on a `rejected` decision (schema-refined).
  declineReason?: string;
  // The command or path as the person edited it on the card before answering; it is what goes back
  // with the answer and what the row then records as having run. Absent when the shown text was
  // answered as it stood. Only on an `approved` decision (schema-refined).
  editedAction?: string;
  auditMetadata?: Record<string, unknown>;
  // Minted by the answering client and echoed on the `approval.approved` / `approval.rejected`
  // event, so the device whose answer landed knows it did and only the others read that it was
  // answered elsewhere.
  clientResolutionId: string;
}
interface ApprovalResolveResponse {
  approvalRequestId: ApprovalRequestId;
  state: ApprovalState;
  effectiveScope: string; // the recorded grant (Spec-010 §Required Behavior)
  resolvedAt: string;
}

// PermissionCheck (daemon-internal pre-execution gate — no wire method string, D-009-5/D-009-18;
// both shapes are the daemon's own, in `crates/sidekicks-approval/src/permission_check.rs`)
type PermissionCheckRequest =
  // A provider's permission ask, under the id the daemon minted for it; `signal` is canceled once
  // the provider takes the ask back, and an ask taken back before its card is raised raises none.
  // tokio_util::sync::CancellationToken
  | { kind: "providerAsk"; ask: ProviderPermissionAsk; askId: string; signal: CancellationToken }
  // A call of one of the app's own tools that its provider runs without asking first (Codex, with
  // the daemon's tool server set to approve): gated by the calling session's level alone.
  | { kind: "toolCall"; sessionId: SessionId; runId: RunId; toolName: string; toolCallId: string }
  // A workflow start an agent's tool or a trigger asks for; `askingRunId` is the calling agent's
  // run, whose posture the Cedar context carries, and a trigger's start names none.
  | { kind: "workflowStart"; workflowId: WorkflowDefinitionId; askingRunId: RunId | undefined };
type PermissionCheckResponse =
  | { allowed: true; reason: "policyAllow" }
  | { allowed: true; reason: "approved" }
  | { allowed: true; reason: "rememberedRule"; rule: ProviderAskRule }
  | { allowed: false; reason: "pendingApproval"; approvalRequestId: ApprovalRequestId }
  | { allowed: false; reason: "denied"; refusal: string }; // `refusal`: the line the agent reads
// D-009-17 semantics, by what asks:
// - providerAsk (no Cedar): policyAllow = the daemon's designed answer, or the level's own allow
//   of an ask its added ask rule sent (a Reviewed removal Claude Code's `Bash(rm *)` rule sent that
//   its own check did not flag); denied = a designed refusal or a session block rule in force on
//   the subject; approved = the person approved the card whose corrected command or path this ask
//   carries out, on the card's own run, taken once (`approval_correction_uses`); rememberedRule =
//   a session allow in force on the subject, where a standing allow may stand; pendingApproval =
//   the card was raised and recorded before the check returned.
// - toolCall (no Cedar): the read gate (`session_list`, `session_search`, `session_options`,
//   `session_read`, `session_wait`) is policyAllow at every level, as the providers' own read
//   tools ask nothing. Any other tool: policyAllow at `sandboxed` and `yolo`; at `readonly`, `ask`
//   and `reviewed`, rememberedRule = a session allow for the tool in force, which the daemon keeps
//   itself and hands no provider (made when the person answers a tool's card "for the session");
//   pendingApproval otherwise, the ordinary `toolExecution` card the caller waits on, which offers
//   the session allow; denied for a run with no level to read.
// - workflowStart (Cedar, `cedar_policy::Authorizer::is_authorized` over the resident policy set):
//   policyAllow on a permit, denied on a forbid, an evaluation error, an owner that does not
//   resolve, or an agent's start whose run has no posture to read; context = `{ posture }` of the
//   asking run, `{}` for a trigger's start. No start waits on a card.
// A card that cannot be recorded rejects with the typed `approval.persistenceUnavailable`, and the
// action does not proceed; a provider ask the check could not decide is refused at its provider.

// `approval.list`
interface ApprovalListRequest {
  sessionId: SessionId;
  state?: ApprovalState; // filter
  category?: ApprovalCategory; // filter
}
interface ApprovalListResponse {
  approvals: Array<{
    id: ApprovalRequestId;
    runId: RunId;
    // recorded requester actor — the agent's actor id, or the device a person's request came from
    // (Spec-010 §Required Behavior)
    requestedBy: string;
    category: ApprovalCategory;
    scope: string;
    // requested resource (Spec-010 §Interfaces And Contracts)
    resourceDescriptor: Record<string, unknown>;
    // What the card shows, derived by the daemon from the request row, so the card's hook reads
    // them here and never from the event stream.
    subject: string; // the derived subject the card names and the remembering answer would cover
    // the provider's own reason for asking, shown as given; absent when it sent none
    reason?: string;
    // whether the remembering answer (`Always allow <subject> this session`) is offered
    standingAllowOffered: boolean;
    // whether that answer's project scope (`Always in this project`) is offered: never in a chat,
    // never on a workflow command step's card, which the daemon raises with no provider's ask, and
    // never without `standingAllowOffered` (schema-refined)
    projectScopeOffered: boolean;
    state: ApprovalState;
    createdAt: string;
    // last state-transition instant (a canceled row settles here; no resolution row)
    updatedAt: string;
    resolvedAt?: string; // resolved quad present iff state ∈ {approved, rejected}
    decision?: ApprovalDecision;
    // AC-3: the answering device, which a card answered elsewhere reads as `Answered on <device>`
    deviceId?: DeviceId;
    effectiveScope?: string; // AC-3: what scope
    rememberedScope?: RememberedScope; // present iff the resolution handed a rule to the provider
  }>;
}

// `approval.rule.list`: the rules in force on the session, the session's own and its project's
// alike, read from where the providers keep them: Claude Code's `list_permission_rules`, Codex's
// project rule files and the session's own answers (Spec-010 §Interfaces And Contracts). A revoked
// rule is gone from the list; its revocation stays on the session's record as
// `approval.rule.revoked`.
interface ApprovalRuleListRequest {
  sessionId: SessionId;
}
interface ApprovalRuleListResponse {
  rules: Array<{
    ruleId: RememberedRuleId; // daemon-minted, stable while the rule's place and text are unchanged
    scope: RememberedScope; // the scope, the derived subject and the sense
  }>;
}

// `approval.rule.revoke`: the explicit revocation path (Spec-010 §State And Data Implications):
// removes the rule where the provider keeps it — a Claude Code session rule from the session's flag
// settings, a Codex session allow by the daemon's hook holding the next call on its subject, a
// project rule from the provider's project file — and emits `approval.rule.revoked`
interface ApprovalRuleRevokeRequest {
  ruleId: RememberedRuleId;
}
interface ApprovalRuleRevokeResponse {
  ruleId: RememberedRuleId;
  revokedAt: string;
  invalidationTrigger: "explicit";
}

// `approval.denial.override`: `Allow once` on a block by the provider's own reviewer at the
// `reviewed` level. It tells the agent it may try that one action again, by the provider's own
// means: on Claude Code the daemon sends the sentence Claude Code's own Recently denied list sends,
// "Permission granted for: <the action>. You may now retry this command if you would like."; on
// Codex it calls `thread/approveGuardianDeniedAction` with the review Codex sent, and Codex's
// reviewer still reviews the retry. The sentence reaches a running turn at once and starts a turn
// when none is running, as that turn's input; it is the daemon's, never drawn as the person's
// message. The first press records `approval.denial.overridden` and settles the block on every
// screen.
interface ApprovalDenialOverrideRequest {
  sessionId: SessionId;
  denialId: DenialId;
}
// The settled override. A press on a block already allowed, from this screen or another, returns
// the same answer with the instant the first press landed and sends the provider nothing. A block
// that is not overridable is refused with `approval.denial.notOverridable`, a `denialId` the daemon
// holds no block for with `approval.denial.notFound`, a press after the block's session has ended
// with `session.alreadyClosed`, and a block whose provider no driver answers with
// `provider.notFound`; a press whose request got no answer back is refused with `provider.timeout`
// or `provider.unavailable`, and a second press answers the same refusal and sends nothing until
// the provider process the request went to has ended (error-contracts.md §Approval, §Session,
// §Provider).
interface ApprovalDenialOverrideResponse {
  denialId: DenialId;
  overriddenAt: string;
}
```

**The providers keep the card's rules.** The session's permission level decides whether anything asks at all: only the careful levels raise a card, and at `sandboxed` and `yolo` no card exists and no rule can be made, but for a removal a provider's own check flags, which that provider asks for at `yolo` too and refuses itself at `sandboxed`, and, at `yolo`, a call one of the person's own ask rules names or a tool the person set to `prompt`; a removal's card carries a standing allow only where the provider offers one, Codex's command rule for a forced `rm`, and none on Claude Code, which withholds it for the removals its check flags. A level move never answers an open card: the card stays for the person and the new level applies from the next ask, on every provider ([Spec-010 §Required Behavior](../../specs/010-approvals-permissions-and-trust-boundaries.md#required-behavior)). A rule the card makes is handed to the provider, which answers by it at every level that asks; the daemon keeps no rule store, and each rule is one provider's. On Claude Code a session rule is the session's flag settings, set by `apply_flag_settings {permissions}` with the whole allow and deny lists on each call, and at Reviewed the ask list `["Bash(rm *)"]` beside them, since the call replaces the whole `permissions` object, all carried at launch by `--settings`, and a project allow rides the answer's `destination: "localSettings"` into `.claude/settings.local.json`, where the daemon writes a project block itself, since a decline drops any rule it carries. On Codex a session allow is `acceptForSession`; the daemon writes a project rule as a `prefix_rule` or `network_rule` into the project's `.codex/rules/sidekicks.rules`, adds that one path to the repository's `.git/info/exclude`, and answers the ask `acceptForSession`; where Codex has no verb — a session allow taken back, a session block, a session allow after a restart — the daemon's own tool hook and its answers to Codex's asks carry it from the session's own answers. The inspector's `Rules` lists and revokes the rules in force on one session through `approval.rule.list` and `approval.rule.revoke`; Settings › Providers lists and revokes every standing rule on the machine through `provider.standingRule.list` and `provider.standingRule.revoke`, from the same files.

**The plan verdict.** A plan turn ends with a held provider request on Claude Code and a plan item on Codex; the daemon turns either into ONE plan record the screen renders and ONE call answers. The record is `plan.proposed`; the call is `plan.resolve`; the verdict is recorded by `plan.accepted`, `plan.handedOff` and `plan.kept`, so the system messages that tell it and a kept plan's `open` survive a reload, and `plan.hold.ended` records a Claude Code plan whose held request ended with no verdict, which settles it `open`. A plan is not an approval: it raises no approval card and appends no `approval.*` event. Each rides the `approvalFlow` category ([Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md), which owns the names and the census), because a plan card is an attention entry on exactly the terms an approval is, which is why the verdict lives beside the approval surface rather than in a namespace of its own.

```ts
// A daemon-minted identifier for one plan record. The record is minted when a plan turn ends and is
// the session artifact the inspector lists and the reader renders (artifact-payloads.md §Plan-011),
// so the id is stable across a reload and across the person's other devices.
type PlanId = string & { readonly __brand: "PlanId" };

// plan.proposed — the record the screen renders. `title` is the plan's first heading and `text` its
// Markdown as the agent wrote it; the two counts are the daemon's own read of the plan, the
// top-level steps and the files the plan names, and they are what the card's summary line states.
// `planFilePath` is present only where the provider wrote the plan as a file, which is one provider
// and not the other — its absence means the plan is an item of the thread and there is no file,
// never that the path is unknown. The text is taken from the held request or the plan item and
// NEVER read off the disk.
interface PlanProposedPayload {
  planId: PlanId;
  sessionId: SessionId;
  runId: RunId;
  artifactId: ArtifactId; // the plan's artifact, written before this record
  title: string;
  text: string;
  stepCount: number;
  fileCount: number;
  planFilePath?: string;
  // true when the provider holds a request open for the verdict (Claude Code), false for a plan
  // item of a finished turn (Codex)
  holdsRequest: boolean;
}

// The verdict's outcomes, each naming the device whose verdict landed.
interface PlanAcceptedPayload {
  planId: PlanId;
  sessionId: SessionId;
  deviceId: DeviceId;
}
interface PlanHandedOffPayload {
  planId: PlanId;
  sessionId: SessionId;
  freshSessionId: SessionId;
  deviceId: DeviceId;
}
// Draws no row.
interface PlanKeptPayload {
  planId: PlanId;
  sessionId: SessionId;
  deviceId: DeviceId;
}
// A Claude Code plan whose held request ended with no verdict settles `open`; draws no row.
interface PlanHoldEndedPayload {
  planId: PlanId;
  sessionId: SessionId;
  reason: "interrupted" | "withdrawn" | "runEnded";
}

// plan.resolve — the one call that answers a plan record. Three verdicts:
//   `keep` — keep planning. `plan.kept` is appended and draws no row, plan mode stays on, and the
//             person's next message is the feedback; the daemon answers a held provider request
//             with a denial carrying the sentence that stops the leg, and leaves the thread in plan
//             mode where there is no request to answer. The record settles `open`: the held request
//             is already denied, so no later verdict can answer it. A revised plan mints a NEW
//             record with new counts.
//   `build` — build here. The build runs on in this session with its history intact; the daemon
//             answers the held request by allowing it and setting the session's own permission
//             mode, or restores the level's sandbox on the thread and starts the next turn.
//   `fresh` — build in a fresh session. The daemon mints a session on the SAME project and
//             worktree, named after the plan's first heading, seeded with the plan and a pointer to
//             the planning conversation's whole transcript, one plain file the daemon writes into
//             the fresh session's own storage; the planning session keeps its whole transcript.
// Written as one shape rather than a union because only one verdict carries members: the arm is
// presence-discriminated on `fresh`, which is REQUIRED on that verdict and forbidden on the other
// two (schema-refined), so a `build` request cannot smuggle a session to mint.
interface PlanResolveRequest {
  planId: PlanId;
  verdict: "keep" | "build" | "fresh";
  // The session to mint, present exactly on `fresh`: the provider it runs and the level it starts
  // at. The account is not one and no client names one — a minted session runs on its provider's
  // current account, the way every session does (provider-account-payloads.md §Plan-023 — Provider
  // Accounts And Credential Homes). Everything else is the planning session's — same project, same
  // worktree, and the plan as the seed.
  fresh?: {
    providerName: ProviderId;
    // The planning session's level, or the level the person picked in the `Fresh session with` list
    // where that provider cannot give it. A level that provider, its account or the model cannot
    // run is refused with `session.permissionLevel.notOffered`, naming the level, and no session is
    // minted.
    level: PermissionLevel;
  };
}
interface PlanResolveResponse {
  planId: PlanId;
  // The plan record's state after the verdict, which is the word the inspector's artifact row
  // reads: `open` after `keep`, `accepted` after `build`, `handedOff` after `fresh`. `waiting` is
  // the record's state only before its first verdict.
  state: Exclude<PlanState, "waiting">; // PlanState: api-payload-contracts.md §Shared Enums
  // Present exactly on an accepted `fresh` verdict: the minted session, so the caller switches to
  // it without a follow-up read.
  freshSessionId?: SessionId;
}
```

## Approval Method-Name Registry

Plan-009's approval surface is exposed as the `approval.*` methods below (D-009-5); the daemon's in-process call that creates an approval request is not one of them: the daemon makes it from a provider's callback, so it has no method string and no SDK method. Names register under the Plan-005-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out (`repoMount.*` precedent). These methods ride the **daemon JSON-RPC transport only** — approval state is daemon-local SQLite per ADR-016 (coordination records only, in the hosted account's storage; no control-plane approval storage or route sibling exists in V1; the person's other devices reach these methods through Remote Control, over their own channel to the machine that runs the session, ADR-016 Option B). Method strings are imperative and disjoint-by-form from the past-participle Spec-005 `approvalFlow` durable event names (`approval.resolve` method vs `approval.approved` event; `approval.rule.revoke` vs `approval.rule.revoked`). `PermissionCheck` is deliberately **not** registered: it is the daemon-internal pre-execution gate (Spec-010: "inside the local daemon"), no V1 client consumes a wire preflight, and exposing one would invite stale-verdict (time-of-check/time-of-use) authorization against the security gate (D-009-5/D-009-18). `approval.list` reads a session's approval requests, waiting and resolved, filtered by state or category; the one waiting request is drawn as a card on the composer.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `approval.resolve` | `mutation` | `ApprovalResolveRequest` | `ApprovalResolveResponse` |
| `approval.list` | `query` | `ApprovalListRequest` | `ApprovalListResponse` |
| `approval.rule.list` | `query` | `ApprovalRuleListRequest` | `ApprovalRuleListResponse` |
| `approval.rule.revoke` | `mutation` | `ApprovalRuleRevokeRequest` | `ApprovalRuleRevokeResponse` |
| `approval.denial.override` | `mutation` | `ApprovalDenialOverrideRequest` | `ApprovalDenialOverrideResponse` |
| `plan.resolve` | `mutation` | `PlanResolveRequest` | `PlanResolveResponse` |

`plan` is a registered namespace root of its own, and this is the only verb in it: the plan verdict is one call, and a plan record is READ from the session's artifact list rather than through a namespace of its own, so no `plan.list` or `plan.read` exists to register. It rides the **daemon JSON-RPC transport only**, for the reason its siblings do — the held provider request the verdict answers is held by this daemon and by nothing else, so a control-plane sibling would place the mutation on a party that cannot answer it. A verdict against a record that is no longer waiting applies nothing and reads back the record's state, as `question.resolve` does, because the first answer settles the plan everywhere and the record is the receipt.

The Rust types live in `crates/sidekicks-contracts/src/approval.rs`; the generated TypeScript keeps `packages/contracts/src/approval.ts`, per the api-payload-contracts.md §Source-of-Truth Policy.
