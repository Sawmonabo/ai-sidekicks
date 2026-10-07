# Approval Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-009 — Approvals Permissions And Trust Boundaries

```ts
// Plan-009 shapes (D-009-1/D-009-3) — canonical origin
// packages/contracts/src/approval.ts. PermissionCheck, whose two shapes live in the daemon
// (`packages/runtime-daemon/src/policy/`, beside the permission check), is a daemon-internal API
// (Spec-010: "inside the local daemon"); it has no JSON-RPC method string and no
// SDK surface in V1 (D-009-5; the in-process check is the composed enforcement
// gate per D-009-18 — evaluate, then on an ask-policy outcome create the request
// via the approval service (whose create persists and emits `approval.requested` —
// the single emission seam), and notify the run-blocking seam before returning).

type RememberedRuleId = string & { readonly __brand: "RememberedRuleId" }; // → api-payload-contracts.md §Branded ID Types

// The rule an approval hands to the provider — explicit enum, not free-form (Spec-010 §Interfaces And
// Contracts). `request_only` (Spec-010 §Default Behavior) is expressed by OMITTING rememberedScope,
// never by an enum member. The subject is the one the daemon derived from the ask and the card
// displayed (D-009-10): a command's program and first subcommand; a network request's host; a written
// file's name. The provider keeps the rule and answers by it, at every level that asks; the daemon keeps
// no rule store, and the session's own answers are its record.
interface RememberedScope {
  // 'session' = the provider's session rule, which the card's middle button makes by being pressed:
  // Claude Code's session flag settings (`apply_flag_settings {permissions}`, each call carrying the
  // whole allow and deny lists and, at Reviewed, `ask: ["Bash(rm *)"]`), Codex's `acceptForSession`.
  // 'project' = the provider's project rule file, which the same button's own arm writes: Claude Code's
  // `.claude/settings.local.json` through the answer's `destination: "localSettings"`, Codex's
  // `.codex/rules/sidekicks.rules`, written by the daemon and listed in the repository's `.git/info/exclude`.
  kind: "session" | "project";
  pattern: string; // the subject the daemon derived from the ask and the card displayed; re-derived at resolve, and an echoed pattern that differs is refused
  // Allow or block. A block is the `network_access` decline's own rule — the host is refused with NO
  // card raised until the rule is replaced — so the rule set is two-sided and
  // a decline is not merely the absence of a grant. REQUIRED rather than defaulted: a missing sense
  // would have to read as `allow`, and a silently-widened block is the one reading a permission rule
  // must never take.
  sense: "allow" | "block";
}

// Why a rule ended: the person revoked it, its session (the provider's own session) ended, or the tool
// server whose tool it covers was removed. A project's rules live in the project's own folder and stay
// with it.
type InvalidationTrigger = "explicit" | "session_end" | "server_removed";

// approval_flow event payloads for six of the `approval.*` types — `requested`, `approved`, `rejected`,
// `canceled`, `remembered`, `rule_revoked` (Spec-005 §Approval Flow; mirror of the canonical Zod
// schemas in `packages/contracts/src/approval.ts`, one per type, each `.strict()`). The payloads
// carry the projection-rebuild fields (D-009-6 rebuild; D-009-7 events-canonical): `requested`
// carries the request fields; the resolution events carry the answering device and the effective
// scope; `remembered` carries the rule the answer handed to the provider (binding =
// `rememberedScope`, origin resolution via `approvalRequestId`), the session's own record of it,
// which the daemon lists and carries across a restart of the provider's process; decision and state
// ride the event type; envelope timestamps supply the created/updated instants. Each type's schema
// requires exactly its own members, so a malformed event fails at the emission parse, never at
// restart projection (I-009-9). The other members of the same category have payloads of their own:
// `moderation.review_flagged`, `approval.reviewer_denied` and `approval.denial_overridden`, see
// their payloads below, and the `plan.*` types, whose records are §The plan verdict's.
interface ApprovalRequestedPayload {
  sessionId: SessionId;
  runId: RunId;
  approvalRequestId: ApprovalRequestId;
  category: ApprovalCategory;
  scope: string;
  requestedBy: string; // recorded requester actor (the agent's actor id, or the device a person's request came from, Spec-010 §Required Behavior)
  resourceDescriptor: Record<string, unknown>; // audit-grade target (Spec-010 §Interfaces And Contracts); on a provider permission ask it also holds the ask's tool name and the provider's own prompt text, where sent
  askId?: string; // present when the request originates from a provider permission ask (Claude Code's can_use_tool for any tool but its question tool, or a Codex approval request), which it records once: the daemon's own id for the ask, a ULID (the provider's request id is delivery routing state, never this id), persisted at creation as the durable ask↔approval association — a restart's rebuild reconstructs which native ask an outcome must answer when several asks are in flight on one run, so the answer reaches the provider across a restart; its presence is required at the CP-009-5 normalizer emission seam (T2.8 — the sole requester a provider ask originates), since the schema cannot know whether a request came from a provider ask; set only by the daemon's in-process create from a provider ask, and never supplied by a client; persisted on the approval_requests projection row (ask_id — local-sqlite-schema.md §Approval Tables)
}
// approval.approved and approval.rejected
interface ApprovalResolvedPayload {
  sessionId: SessionId;
  runId: RunId;
  approvalRequestId: ApprovalRequestId;
  category: ApprovalCategory;
  scope: string;
  effectiveScope: string; // recorded effective scope (≤ requested, I-009-6)
  deviceId: DeviceId; // the answering device's id, the device whose connection carried the answer; a card answered elsewhere reads it as `Answered on <device>`
  clientResolutionId: string; // the resolving request's own `clientResolutionId`, echoed so the device whose answer landed knows it did
}
interface ApprovalCanceledPayload {
  sessionId: SessionId;
  runId: RunId;
  approvalRequestId: ApprovalRequestId;
  category: ApprovalCategory;
  scope: string;
}
interface ApprovalRememberedPayload {
  sessionId: SessionId;
  runId: RunId;
  approvalRequestId: ApprovalRequestId;
  category: ApprovalCategory;
  scope: string;
  nodeId: NodeId; // the machine whose provider keeps the rule
  ruleId: RememberedRuleId;
  rememberedScope: RememberedScope;
}
interface ApprovalRuleRevokedPayload {
  sessionId: SessionId;
  category: ApprovalCategory;
  scope: string;
  ruleId: RememberedRuleId;
  invalidationTrigger: InvalidationTrigger;
  runId?: RunId; // absent where no ask was in flight, as when a project is detached or a tool server is removed
  approvalRequestId?: ApprovalRequestId; // ditto
}

// moderation.review_flagged payload — an `approval_flow` event with its own shape
// (Spec-005 §Approval Flow registry row). A warning or a required review from Codex's own
// reviewer at the `reviewed` level, which the flow draws as one system message with no control,
// in the words `text` carries. The Codex driver's event normalizer emits it (Plan-003 T3.33) from
// those Codex signals; Codex's per-turn moderation metadata, a display hint with no words,
// is never this event and stays in the daemon's log. Claude Code sends no such signal.
interface ModerationReviewFlaggedPayload {
  sessionId: SessionId;
  runId: RunId;
  agentId: AgentId;
  // Required; always resolves to the event of the approval request or tool call Codex's reviewer holds.
  eventId: string;
  // `review_warning`: a `guardianWarning`, drawn `Review warning · <text>`. The normalizer pairs each
  // warning with the review Codex completes right after it and records none for a warning that
  // reports an approval, or for one about an action the reviewer blocked, whose words are on that
  // action's own row (`approval.reviewer_denied`).
  // `review_required`: an `autoApprovalReview/strictReviewRequired`, drawn `Review required · <text>`.
  signal: "review_warning" | "review_required";
  // The words the row shows. For a warning, Codex's sentence exactly as Codex sent it. A required
  // review carries no words, so its text is the sentence Codex's own app writes for it:
  // "This request requires additional safety checks, some tool calls might take extra time".
  text: string;
}

// A daemon-minted identifier for one block by the provider's own reviewer. It is stable across a
// restart and across the person's devices, so a press on any screen names the same block.
type DenialId = string & { readonly __brand: "DenialId" };

// approval.reviewer_denied payload — an `approval_flow` event with its own shape (Spec-005 §Approval
// Flow registry row). At the `reviewed` level the provider's own reviewer blocked one action — Claude
// Code's auto-mode classifier, captured by its `PermissionDenied` hook and the result's
// `permission_denials`; Codex's automatic reviewer, captured from `item/autoApprovalReview/completed`.
// The blocked call keeps its row in the flow, a failed row whose reason line reads
// `Blocked · <reason>`, with one button, `Allow once`, wherever `overridable` is true. The daemon keeps
// the provider's own denial with this record — Claude Code's action as the hook received it, Codex's
// review as Codex sent it — so an override still works after a restart; it never rides the payload.
interface ApprovalReviewerDeniedPayload {
  sessionId: SessionId;
  runId: RunId;
  agentId: AgentId;
  denialId: DenialId;
  // The event of the blocked call, whose row carries the reason line and the button.
  eventId: string;
  // The reviewer's reason in the provider's own words: Claude Code's denial reason, such as
  // `[Data Exfiltration]`; Codex's review rationale.
  reason: string;
  // False where the provider lets no person overrule the block — Claude Code's block without a
  // classifier verdict, and Codex's review that timed out — and the row then carries no button.
  overridable: boolean;
}

// approval.denial_overridden payload — an `approval_flow` event with its own shape. The person pressed
// `Allow once` and the agent was told it may try that one action again; the row reads `Allowed once`
// and the button goes on every screen. The agent decides whether to retry, and nothing runs by itself.
interface ApprovalDenialOverriddenPayload {
  sessionId: SessionId;
  denialId: DenialId;
}
// ApprovalResolve
interface ApprovalResolveRequest {
  approvalRequestId: ApprovalRequestId;
  decision: ApprovalDecision;
  effectiveScope?: string; // granted scope; defaults server-side to the request's scope; never broader than requested
  // The rule this resolution hands to the provider, absent for a one-time answer. Its `sense` must agree
  // with `decision` — an `approved` resolution mints an `allow`, a `rejected` one a `block` — and the
  // pair is schema-refined, so a decline cannot mint a grant. A block is reachable only from the
  // `network_access` category, which is the one ask whose decline has a subject worth blocking.
  // `pattern` carries the DERIVED SUBJECT the card's own button displayed: for a command, the program
  // and its first subcommand; for a network request, the host; for a file write, the file's name.
  // The daemon derives it from the ask and the client echoes what it showed, so the rule can never
  // cover more than the words the person pressed.
  rememberedScope?: RememberedScope;
  // What the person typed on `Decline`'s one optional line, sent to the agent through the provider's own
  // refusal field; absent sends a bare decline. Only on a `rejected` decision (schema-refined).
  declineReason?: string;
  // The command or path as the person edited it on the card before answering; it is what goes back with
  // the answer and what the row then records as having run. Absent when the shown text was answered as
  // it stood. Only on an `approved` decision (schema-refined).
  editedAction?: string;
  auditMetadata?: Record<string, unknown>;
  // Minted by the answering client and echoed on the `approval.approved` / `approval.rejected` event, so
  // the device whose answer landed knows it did and only the others read that it was answered elsewhere.
  clientResolutionId: string;
}
interface ApprovalResolveResponse {
  approvalRequestId: ApprovalRequestId;
  state: ApprovalState;
  effectiveScope: string; // the recorded grant (Spec-010 §Required Behavior)
  resolvedAt: string;
}

// PermissionCheck (daemon-internal pre-execution gate — no wire method string, D-009-5/D-009-18;
// both shapes are the daemon's own, in `packages/runtime-daemon/src/policy/`)
interface PermissionCheckRequest {
  runId: RunId;
  category: ApprovalCategory;
  scope: string;
  resourceDescriptor: Record<string, unknown>;
}
interface PermissionCheckResponse {
  allowed: boolean;
  reason: "policy_allow" | "remembered_rule" | "approved" | "pending_approval" | "denied";
  // D-009-17 semantics: policy_allow = a built-in permit with no human approval artifact — plain
  // code answering a provider's ask, Cedar for the app's own tools (Spec-010 §Required Behavior);
  // remembered_rule = the session's own answers carry an allow on this subject that the daemon
  // answers for a provider with no verb of its own (a Codex session allow after a restart);
  // approved = a recorded approved resolution covers this exact request; pending_approval = request
  // created/open (allowed=false); denied = a built-in refusal (plain code on a provider's ask, a
  // Cedar forbid on the app's own tools), a rejected
  // resolution, a host the session blocked on Codex, which has no session block of its own, or
  // fail-closed refusal (the typed `approval.persistence_unavailable`
  // error additionally surfaces on fail-closed paths so audit can distinguish them).
  // Invariants: allowed === (reason ∈ {policy_allow, remembered_rule, approved});
  approvalRequestId?: ApprovalRequestId; // present iff reason = 'pending_approval': the one request
  // the ask opened, which the first answer from any device settles.
}

// ApprovalProjectionRead
interface ApprovalProjectionReadRequest {
  sessionId: SessionId;
  state?: ApprovalState; // filter
  category?: ApprovalCategory; // filter
}
interface ApprovalProjectionReadResponse {
  approvals: Array<{
    id: ApprovalRequestId;
    runId: RunId;
    requestedBy: string; // recorded requester actor — the agent's actor id, or the device a person's request came from (Spec-010 §Required Behavior)
    category: ApprovalCategory;
    scope: string;
    resourceDescriptor: Record<string, unknown>; // requested resource (Spec-010 §Interfaces And Contracts)
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
    updatedAt: string; // last state-transition instant (a canceled row settles here; no resolution row)
    resolvedAt?: string; // resolved quad present iff state ∈ {approved, rejected}
    decision?: ApprovalDecision;
    deviceId?: DeviceId; // AC-3: the answering device, which a card answered elsewhere reads as `Answered on <device>`
    effectiveScope?: string; // AC-3: what scope
    rememberedScope?: RememberedScope; // present iff the resolution handed a rule to the provider
  }>;
}

// RememberedRuleList — the rules in force on the session, the session's own and its project's alike,
// read from where the providers keep them: Claude Code's `list_permission_rules`, Codex's project rule
// files and the session's own answers (Spec-010 §Interfaces And Contracts). A revoked rule is gone
// from the list; its revocation stays on the session's record as `approval.rule_revoked`.
interface RememberedRuleListRequest {
  sessionId: SessionId;
}
interface RememberedRuleListResponse {
  rules: Array<{
    ruleId: RememberedRuleId; // daemon-minted, stable while the rule's place and text are unchanged
    scope: RememberedScope; // the scope, the derived subject and the sense
  }>;
}

// RememberedRuleRevoke — the explicit revocation path (Spec-010 §State And Data Implications): removes
// the rule where the provider keeps it — a Claude Code session rule from the session's flag settings, a
// Codex session allow by the daemon's hook holding the next call on its subject, a project rule from the
// provider's project file — and emits `approval.rule_revoked`
interface RememberedRuleRevokeRequest {
  ruleId: RememberedRuleId;
}
interface RememberedRuleRevokeResponse {
  ruleId: RememberedRuleId;
  revokedAt: string;
  invalidationTrigger: "explicit";
}

// ApprovalDenialOverride — `Allow once` on a block by the provider's own reviewer at the `reviewed`
// level. It tells the agent it may try that one action again, by the provider's own means: on Claude
// Code the daemon sends the sentence Claude Code's own Recently denied list sends, "Permission granted
// for: <the action>. You may now retry this command if you would like."; on Codex it calls
// `thread/approveGuardianDeniedAction` with the review Codex sent, and Codex's reviewer still reviews
// the retry. The sentence reaches a running turn at once and starts a turn when none is running, as
// that turn's input; it is the daemon's, never drawn as the person's message. The first press records
// `approval.denial_overridden` and settles the block on every screen.
interface ApprovalDenialOverrideRequest {
  sessionId: SessionId;
  denialId: DenialId;
}
// The settled override. A press on a block already allowed, from this screen or another, returns the
// same answer with the instant the first press landed and sends the provider nothing. A block that is
// not overridable is refused with `approval.denial_not_overridable`, a `denialId` the daemon holds no
// block for with `approval.denial_not_found`, and a press after the block's session has ended with
// `session.already_closed` (error-contracts.md §Approval, §Session).
interface ApprovalDenialOverrideResponse {
  sessionId: SessionId;
  denialId: DenialId;
  overriddenAt: string;
}
```

**The providers keep the card's rules.** The session's permission level decides whether anything asks at all: only the careful levels raise a card, and at the levels that never ask no card exists and no rule can be made — moving a session's level to one of those while a card is open ANSWERS that card and the blocked row runs. A rule the card makes is handed to the provider, which answers by it at every level that asks; the daemon keeps no rule store, and each rule is one provider's. On Claude Code a session rule is the session's flag settings, set by `apply_flag_settings {permissions}` with the whole allow and deny lists on each call, and at Reviewed the ask list `["Bash(rm *)"]` beside them, since the call replaces the whole `permissions` object, all carried at launch by `--settings`, and a project allow rides the answer's `destination: "localSettings"` into `.claude/settings.local.json`, where the daemon writes a project block itself, since a decline drops any rule it carries. On Codex a session allow is `acceptForSession`; the daemon writes a project rule as a `prefix_rule` or `network_rule` into the project's `.codex/rules/sidekicks.rules`, adds that one path to the repository's `.git/info/exclude`, and answers the ask `acceptForSession`; where Codex has no verb — a session allow taken back, a session block, a session allow after a restart — the daemon's own tool hook and its answers to Codex's asks carry it from the session's own answers. The inspector's `Rules` lists and revokes the rules in force on one session through `approval.ruleList` and `approval.ruleRevoke`; Settings › Providers lists and revokes every standing rule on the machine through `provider.standingRuleList` and `provider.standingRuleRevoke`, from the same files.

**The plan verdict.** A plan turn ends with a held provider request on Claude Code and a plan item on Codex; the daemon turns either into ONE plan record the screen renders and ONE call answers. The record is `plan.proposed`; the call is `plan.resolve`; the outcome is recorded by `plan.accepted` and `plan.handed_off`, so the system messages that tell it survive a reload. Each rides the `approval_flow` category ([Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md), which owns the names and the census), because a plan card is an attention entry on exactly the terms an approval is, which is why the verdict lives beside the approval surface rather than in a namespace of its own.

```ts
// A daemon-minted identifier for one plan record. The record is minted when a plan turn ends and is
// the session artifact the inspector lists and the reader renders (artifact-payloads.md §Plan-011), so the id is
// stable across a reload and across the person's other devices.
type PlanId = string & { readonly __brand: "PlanId" };

// plan.proposed — the record the screen renders. `title` is the plan's first heading and `text` its
// Markdown as the agent wrote it; the two counts are the daemon's own read of the plan, the
// top-level steps and the files the plan names, and they are what the card's summary line states.
// `planFilePath` is present only where the provider wrote the plan as a file, which is one provider
// and not the other — its absence means the plan is an item of the thread and there is no file, never
// that the path is unknown. The text is taken from the held request or the plan item and NEVER read
// off the disk.
interface PlanProposedPayload {
  planId: PlanId;
  sessionId: SessionId;
  runId: RunId;
  title: string;
  text: string;
  stepCount: number;
  fileCount: number;
  planFilePath?: string;
}

// plan.resolve — the one call that answers a plan record. Three verdicts:
//   `keep`  — keep planning. Nothing is appended, plan mode stays on, and the person's next message
//             is the feedback; the daemon answers a held provider request with a denial carrying the
//             sentence that stops the leg, and leaves the thread in plan mode where there is no
//             request to answer. The record settles `open`: the held request is already denied, so no
//             later verdict can answer it. A revised plan mints a NEW record with new counts.
//   `build` — build here. The build runs on in this session with its history intact; the daemon
//             answers the held request by allowing it and setting the session's own permission mode,
//             or restores the level's sandbox on the thread and starts the next turn.
//   `fresh` — build in a fresh session. The daemon mints a session on the SAME project and worktree,
//             named after the plan's first heading, seeded with the plan; the planning session keeps
//             its whole transcript.
// Written as one shape rather than a union because only one verdict carries members: the arm is
// presence-discriminated on `fresh`, which is REQUIRED on that verdict and forbidden on the other two
// (schema-refined), so a `build` request cannot smuggle a session to mint.
interface PlanResolveRequest {
  planId: PlanId;
  verdict: "keep" | "build" | "fresh";
  // The session to mint, present exactly on `fresh`: the provider it runs and the level it starts
  // at. The account is not one and no client names one — a minted session runs on its provider's
  // current account, the way every session does (provider-account-payloads.md §Plan-023 — Provider Accounts And Credential Homes).
  // Everything else is the planning session's — same project, same worktree, and the plan as the seed.
  fresh?: {
    driverName: ProviderName;
    // The planning session's level, or the level the person picked in the `Fresh session with` list
    // where that provider cannot give it. A level that provider, its account or the model cannot run
    // is refused with `session.permission_level_unavailable`, naming the level, and no session is
    // minted.
    level: PermissionLevel;
  };
}
interface PlanResolveResponse {
  planId: PlanId;
  // The plan record's state after the verdict, which is the word the inspector's artifact row reads:
  // `open` after `keep`, `accepted` after `build`, `handed_off` after `fresh`. `waiting` is the record's
  // state only before its first verdict.
  state: "open" | "accepted" | "handed_off";
  // Present exactly on an accepted `fresh` verdict: the minted session, so the caller switches to it
  // without a follow-up read.
  freshSessionId?: SessionId;
}
```

## Approval Method-Name Registry

Plan-009's approval surface is exposed as the `approval.*` methods below (D-009-5); `approval.requestCreate` is not one of them: the daemon raises it in process from a provider's callback, so it has no method string and no SDK method. Names register under the Plan-005-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out (`repo.*` precedent). These methods ride the **daemon JSON-RPC transport only** — approval state is daemon-local SQLite per ADR-016 (coordination-records-only Postgres; no control-plane approval storage or tRPC sibling exists in V1; the person's other devices reach these methods through Remote Control, over their own channel to the machine that runs the session, ADR-016 Option B). Method strings are imperative and disjoint-by-form from the past-participle Spec-005 `approval_flow` durable event names (`approval.resolve` method vs `approval.approved` event; `approval.ruleRevoke` vs `approval.rule_revoked` — the underscore event form is regex-invalid as a method name). `PermissionCheck` is deliberately **not** registered: it is the daemon-internal pre-execution gate (Spec-010: "inside the local daemon"), no V1 client consumes a wire preflight, and exposing one would invite stale-verdict (time-of-check/time-of-use) authorization against the security gate (D-009-5/D-009-18). The console has no approvals list of its own, so no plural list method exists: the one waiting request is a card on the composer.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `approval.resolve` | `mutation` | `ApprovalResolveRequest` | `ApprovalResolveResponse` |
| `approval.projectionRead` | `query` | `ApprovalProjectionReadRequest` | `ApprovalProjectionReadResponse` |
| `approval.ruleList` | `query` | `RememberedRuleListRequest` | `RememberedRuleListResponse` |
| `approval.ruleRevoke` | `mutation` | `RememberedRuleRevokeRequest` | `RememberedRuleRevokeResponse` |
| `approval.denialOverride` | `mutation` | `ApprovalDenialOverrideRequest` | `ApprovalDenialOverrideResponse` |
| `plan.resolve` | `mutation` | `PlanResolveRequest` | `PlanResolveResponse` |

`plan` is a registered namespace root of its own, and this is the only verb in it: the plan verdict is one call, and a plan record is READ from the session's artifact list rather than through a namespace of its own, so no `plan.list` or `plan.read` exists to register. It rides the **daemon JSON-RPC transport only**, for the reason its siblings do — the held provider request the verdict answers is held by this daemon and by nothing else, so a control-plane sibling would place the mutation on a party that cannot answer it. A verdict against a record that is no longer waiting applies nothing and reads back the record's state, as `question.resolve` does, because the first answer settles the plan everywhere and the record is the receipt.

Canonical Zod schemas live in `packages/contracts/src/approval.ts` per the api-payload-contracts.md §Source-of-Truth Policy.
