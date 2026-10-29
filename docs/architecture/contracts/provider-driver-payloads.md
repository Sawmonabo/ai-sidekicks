# Provider Driver Payload Contracts

Part of [API Payload Contracts](./api-payload-contracts.md), which holds the shared types, the error envelope and the conventions every shape here uses.

## Plan-003 — Provider Driver Contract (Internal Interface)

```ts
// Internal driver interface (a Rust trait in the daemon). Two kinds of nominal surface ship here.
// (a) The daemon-CONSTRUCTED param types (`CreateSessionParams` … `ApplyInterventionParams` + the
// intervention payloads) are genuinely trusted — the daemon constructs them in-process. (b) The
// driver-CONSTRUCTED returns — the capability flags, `DriverCapabilities`, `GetCapabilitiesResult`,
// `ProviderSessionHandle`, and `ProviderModel`/`ProviderMode` — are normalized at the Plan-003
// Phase-3 driver boundary (the driver, daemon-owned code, parses raw provider output there) and
// returned to the daemon as already-trusted normalized values, so they ship nominal by design and
// are not re-parsed at this contract layer. Their persisted free-form fields
// (`DriverCapabilities.contractVersion`, `ProviderSessionHandle.resumeHandle`, and
// `DriverCliVersionReport.rawVersion` — the CLI-version string as the provider printed it, riding
// the nominal `GetCapabilitiesResult` return exactly like `contractVersion`) are bounded at the
// Plan-003 Phase-2 write seam (semver / non-empty + length + NUL), not here. The contract checks
// (serde shapes and garde checks) run ONLY on the surfaces that parse UNTRUSTED provider output
// (the trust boundary): the result envelopes `DriverResumeResult`, `MoveSessionToForkResult`,
// `DriverGoalResult`, and `DriverAuthProbeResult`, provider-declared
// `ProviderToolMetadata`, and the driver-normalized `CallbackToolInvocation` /
// `McpServerStatusEmission` (each built from provider wire output before the daemon-injected seam
// sees it). `resumeSession` returns the `DriverResumeResult` discriminated union (defined below) to
// make silent-replacement structurally inexpressible per Spec-004 §Fallback Behavior.
// `getCapabilities` returns the `GetCapabilitiesResult` wrapper (defined in
// provider-driver-capability-payloads.md) so the per-tool `ProviderToolMetadata[]` rides alongside
// the flag matrix in a single round-trip per Plan-003 Phase 4. Within the checked surfaces,
// `ProviderToolMetadata` is tolerant and drops unknown keys (Spec-004 §Default Behavior
// forward-compat: "Unknown capability fields are ignored (tolerant reader)" — contractVersion is
// change-detection, not negotiation), while the result envelopes refuse unknown keys
// (`deny_unknown_fields`); and every untrusted provider-output free-form string
// (`ProviderToolMetadata.name`/`.description`, `ApplyInterventionResponse.fallbackAction`,
// `DriverResumeResult.bindingId`/`.providerFailureDetail`,
// `MoveSessionToForkResult.fallbackAction`, `DriverGoalResult.fallbackAction`,
// `DriverAuthProbeResult.detail`, `CallbackToolInvocation.toolName`/`.toolCallId`,
// `McpServerStatusEmission.serverName`
// and `ProviderCommandEntry.name`/`.description`/`.scope`/`.argumentHint`/`.server` plus
// `ProviderOutputSpeedState.declared`/`.reason`, the ones that reach a client: both shapes are
// built from provider-, skill- or tool-server-authored metadata at the driver's own normalize
// boundary and both travel to a client, so an unbounded one is an arbitrarily large IPC response
// and renderer workload) — each on a checked result envelope, `ProviderToolMetadata`, or a
// driver-normalized seam shape (`CallbackToolInvocation` / `McpServerStatusEmission` /
// `ProviderCommandEntry` / `ProviderOutputSpeedState`) below and in
// provider-driver-capability-payloads.md — are bounded (length + non-whitespace + NUL-rejection) by
// the `FreeFormText<MAX>` text newtype — rules not expressible in these TS interface shapes. The
// daemon's provider layer (`crates/sidekicks-provider/src/`) realizes this enumeration for
// the driver-internal shapes, `ApplyInterventionResponse` among them, a driver result the daemon
// keeps in `crates/sidekicks-provider/src/driver/run_control.rs`;
// `crates/sidekicks-contracts/src/provider/driver/commands.rs` (`ProviderCommandEntry`) and
// `output_speed.rs` (`ProviderOutputSpeedState`) in the same folder realize it for the ones that
// reach a client, and `crates/sidekicks-contracts/src/wire/text.rs` holds the
// `FreeFormText<MAX>` newtype they use.
interface ProviderDriver {
  createSession(params: CreateSessionParams): Promise<ProviderSessionHandle>;
  resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult>;
  startRun(params: StartRunParams): Promise<void>;
  interruptRun(params: InterruptRunRequest): Promise<void>;
  applyIntervention(params: ApplyInterventionParams): Promise<ApplyInterventionResponse>;
  // Move the session itself onto a NEW provider conversation forked from the bound one at a
  // message. Never a rollback (see `MoveSessionToForkParams`).
  moveSessionToFork(params: MoveSessionToForkParams): Promise<MoveSessionToForkResult>;
  // Cut the bound conversation IN PLACE back to a message: undo's conversation leg (see the note
  // beside `MoveSessionToForkParams`). Mechanics and shapes: Spec-004 §Interfaces And Contracts.
  rewindConversation(params: RewindConversationParams): Promise<RewindConversationResult>;
  respondToRequest(params: RespondToRequestParams): Promise<void>;
  // `Allow once` on a block by the provider's own reviewer at the `reviewed` level: the driver half
  // of `approval.denial.override`. Claude Code's driver sends the sentence Claude Code's own
  // Recently denied list sends; Codex's driver calls `thread/approveGuardianDeniedAction` with the
  // review Codex sent, and Codex's reviewer still reviews the retry. It reaches a running turn at
  // once and starts a turn when none is running. It retries nothing itself: the agent decides
  // whether to try again.
  overrideDenial(params: OverrideDenialParams): Promise<void>;
  setSessionGoal(params: SetSessionGoalParams): Promise<DriverGoalResult>;
  clearSessionGoal(params: ClearSessionGoalParams): Promise<DriverGoalResult>;
  closeSession(params: CloseSessionParams): Promise<void>;
  // The provider's catalog for a session's model control, read against the account the params
  // name, or the provider's default account where they name none.
  listModels(params: ListModelsParams): Promise<ProviderModel[]>;
  listModes(): Promise<ProviderMode[]>;
  getCapabilities(): Promise<GetCapabilitiesResult>;
  probeAuth(): Promise<DriverAuthProbeResult>;
  // Compose the hand-over brief a session on a DIFFERENT provider is started from, on a throwaway
  // copy of the old session and never on the live one; required of every driver (Spec-004
  // §Interfaces And Contracts; Spec-014 §Continuity, and what is declared rather than dropped). It
  // returns the old provider's own summary of the copy, asked for in one shape on every provider,
  // or the fixed template where that summary is not readable, saying which of the two it is, with
  // the declared-loss list. What follows the summary — the last two exchanges word for word — and
  // the plain transcript file written beside the brief are the daemon's. The copy's one turn is
  // spent on the session's own account; the live session starts no turn and its conversation is
  // unchanged. The brief starts no turn of its own on the new provider: the daemon puts it at the
  // head of the person's next message, or sends it alone at an `interruptAndSwitch`.
  exportHandoverBrief(params: ExportHandoverBriefParams): Promise<DriverHandoverBriefResult>;
  // Ask the provider to compact the bound session's OWN context, on a user's explicit
  // request and never on a threshold, timer, or heuristic (Spec-004 §User-
  // triggered context compaction). Gated on `contextCompaction`. It SETTLES on the provider's
  // typed compaction evidence — the frame that already produces agent.run.context.compacted — and
  // NEVER on the request being accepted: the Codex method answers an empty ack and the Claude leg
  // is a driver_command frame that only settles, so acceptance is evidence of delivery and of
  // nothing else. There is deliberately NO prompt-injected emulation arm; a driver that cannot
  // compact declares the flag false and the call refuses as provider.capability.unsupported.
  // The driver keeps no wait limit of its own: the call settles on the provider's own frame, or
  // `failed` with `notCompacted` when the provider ends the compaction's own turn without the
  // frame, `bindingLost` when the run's runtime binding stops being live (a provider that exits
  // mid-compaction) or `providerError`; never `applied` without the frame. A compaction
  // frame the call did not ask for normalizes into agent.run.context.compacted exactly as an
  // unsolicited provider-initiated compaction does, so no boundary escapes Spec-003's rewind
  // classifier.
  compactContext(params: CompactContextParams): Promise<AgentRunContextCompactResponse>;
  // Read the provider's own enumeration of native slash-commands and skills for the bound
  // session (Spec-004 §The provider command and skill surface). Gated on
  // `providerCommands`. A LIVE read held as driver-session state and discarded with it: not
  // persisted, not cached across sessions, and folded into no projection — which is why this
  // capability adds no table and no column. Every entry carries the (providerName,
  // providerAccountId) it was read under, and that binding is a ROUTING INVARIANT: an entry is
  // offerable only to agents of that same binding, and the one entry V1 dispatches is dispatchable
  // only through them. The driver answers ONE group, carrying the run and binding the params
  // name, every entry stamped with that binding; the daemon joins the groups of an agent's
  // bindings into the reply.
  listProviderCommands(params: ListProviderCommandsParams): Promise<ProviderCommandBindingGroup>;
  // The output-speed state the provider last declared for the session's live binding, verbatim
  // (Spec-004 §The output-speed axis), for a driver declaring `outputSpeed`. A synchronous read
  // of state the driver already holds; `undefined` with no live binding or no declaration yet,
  // which means unread, never off, and never the requested level, which may differ.
  observedOutputSpeedFor(sessionId: SessionId): ProviderOutputSpeedState | undefined;
}

// Supplied to each driver when it is built, beside its other report callbacks: receives, once per
// run, the declared output-speed state that run runs at, read once the run's carrier has settled
// (Claude Code: the handshake of the turn the run starts, after any `apply_flag_settings` it sent;
// Codex: the settings-changed notice the run's `turn/start` produced, or the turn's first item
// where the turn left the tier alone; either: the turn's end where neither arrived). Nothing is
// reported for a run whose turn was never written or a binding that never declared a state. The
// run engine compares it with the level the run carried (Plan-002's `fastOutputUnavailable`).
type RunOutputSpeedSettledListener = (
  sessionId: SessionId,
  runId: RunId,
  state: ProviderOutputSpeedState,
) => void;

// Console-parity shapes (Spec-004 §Desktop Console Parity Surfaces).
//
// AUTHORIZATION (both client-facing operations, `agent.run.context.compact` and
// `session.providerCommand.subscribe`, at the wire boundary — before the capability gate and before
// any driver dispatch). Neither mints a Cedar action and neither mints an error code.
//   * A session that does not exist is refused the already-registered `session.notFound`.
//   * Any connection that reaches the session may call either one; nothing checks who the caller
//     is (api-payload-contracts.md §Authenticated Principal And Authorization Model, run control).
//
// WIRE ADDRESSING. Neither client-facing operation takes a `bindingId`, and the daemon resolves the
// live runtime binding at dispatch. This is not stylistic: no client-facing read publishes a
// `bindingId` anywhere, so a binding-addressed wire request would be unconstructible from every
// response a client can obtain, and a client that somehow held one would be holding a
// daemon-internal lifecycle identifier whose liveness it cannot check.
//
// Each takes the identifier its own authorization and its own consumer already use:
//   * `agent.run.context.compact` takes a RUN. It mutates that run's provider context, so the run
//     is what it acts on.
//   * `session.providerCommand.subscribe` takes a SESSION. The `/` list is bound to the session's
//     live provider process, so the daemon follows that process and a new process brings a new
//     list; the client never names an agent, a run or a binding to get it. Every entry still
//     carries the `(providerName, providerAccountId)` it was read under ([Spec-004 §The provider
//     command and skill
// surface](../../specs/004-provider-driver-contract-and-capabilities.md#the-provider-command-and-skill-surface)).
//
// `agent.run.context.compact` refuses in a FIXED ORDER, each on an ALREADY-REGISTERED code, so this
// addressing mints none: `session.notFound` (unknown session), then `agent.run.notFound` (no such
// run, or not one of that session), then `provider.unavailable` (no live runtime binding: one was
// never started, or the process is gone). A live binding whose driver lacks the flag still refuses
// at the capability gate with `provider.capability.unsupported`. A caller therefore cannot name
// another leg's binding at all: the class of request the driver-side dispatch check exists to
// reject is unrepresentable on the wire, and that check remains as the daemon-interior backstop
// rather than as the only one.
interface AgentRunContextCompactRequest {
  sessionId: SessionId;
  runId: RunId;
}

interface SessionAddressedRequest {
  sessionId: SessionId;
}

// The DRIVER-FACING params, composed by the daemon AFTER that resolution. They stay binding-
// addressed because run -> bindings is 1:many and the operation acts on exactly one leg; they
// cross no wire, and no client constructs one.
interface CompactContextParams {
  sessionId: SessionId;
  // Daemon-resolved at dispatch, the same per-binding addressing goal delivery uses: run ->
  // bindings is 1:many, so the operation names the leg it acts on.
  bindingId: string;
}

// The result of a compaction ATTEMPT, not of the request — a DISCRIMINATED UNION on `status`, so no
// arm can carry a member another arm's state makes meaningless and no consumer has to guess which
// optional members its arm implies. `applied` is reachable only after the provider's typed
// compaction frame is observed, and `boundaryPosition` is REQUIRED there, typed `number | null` so
// a frame carrying no position is representable without being synthesized. `refused` means NOTHING
// WAS SENT; `failed` means something was sent and no boundary was witnessed. There is deliberately
// no `capabilityUndeclared` reason: an undeclared flag refuses at the static capability gate with
// `provider.capability.unsupported` BEFORE the driver is called ([Spec-004 §Required
// Behavior](../../specs/004-provider-driver-contract-and-capabilities.md#required-behavior)), so an
// arm for it would be a second, contradictory encoding of one refusal.
type AgentRunContextCompactResponse =
  | { status: "applied"; boundaryPosition: number | null }
  // `commandAbsent`: the pre-dispatch presence check on the emulated leg did not find the command
  // in the provider's own enumeration for this binding. A person's compaction is accepted from any
  // connection the transport admits, so no arm refuses a caller.
  | { status: "refused"; reason: "commandAbsent" }
  // `bindingLost`: the run's runtime binding stopped being live (process exit or disposal) before
  // the provider's compaction frame arrived. `providerError`: the mechanism itself errored.
  // `notCompacted`: the provider ended the compaction's own turn with no compaction frame, as
  // Claude Code does with `Not enough messages to compact.` and Codex with a compaction that
  // failed. Every arm records a diagnostic; none is silent, and none can settle `applied`.
  | { status: "failed"; reason: "bindingLost" | "providerError" | "notCompacted" };

interface ListProviderCommandsParams {
  sessionId: SessionId;
  bindingId: string;
  // The driver and account the daemon resolved the binding to, which the group and each entry
  // carry as read; the driver re-checks none of it.
  binding: ProviderCommandBinding;
  // The one live run of the agent on the binding; null when several are live.
  runId: RunId | null;
}

// The DRIVER-FACING params of `listModels`. The daemon names the session and its own bound account
// for the session's own provider, and neither for every other provider, which reads its default
// account.
interface ListModelsParams {
  sessionId: SessionId | null;
  providerAccountId: ProviderAccountId | null;
}

// Why one provider's models or modes could not be read. `code` is the refusal the read answered
// (`provider.timeout`, `provider.unavailable`, `provider.commandPath.notRunnable` for a command
// path the person typed with nothing runnable at it, ...); `providerFailureDetail` is the
// provider's own words, where it gave any.
interface ProviderReadFailure {
  code: string;
  providerFailureDetail?: string;
}

// `provider.model.list {sessionId}` answers one outcome per installed provider, the session's own
// provider first and then the provider table's order; a provider whose bare command name no search
// found is not installed and has no entry. Each entry is its catalog or the failure its read
// answered, so one provider's outage never hides another's models and a failure never reads as an
// empty catalog.
type ProviderModelReport =
  | { providerName: ProviderId; models: ProviderModel[] }
  | { providerName: ProviderId; failure: ProviderReadFailure };

interface ProviderModelListResponse {
  providers: ProviderModelReport[];
}

// `provider.mode.list` answers the same way: one outcome per installed provider in the provider
// table's order, its modes or the failure their read answered, a provider not installed left out.
type ProviderModeReport =
  | { providerName: ProviderId; modes: ProviderMode[] }
  | { providerName: ProviderId; failure: ProviderReadFailure };

interface ProviderModeListResponse {
  providers: ProviderModeReport[];
}

// One enumerated provider command, skill or tool-server prompt. `binding` is not decoration: it is
// the routing key the invariant is enforced on, carried WITH the data so a consumer cannot lose it
// by filtering a held list instead of re-reading. `kind` distinguishes the things published under
// one syntax — a provider's command, a skill, and a working tool server's prompt, which carries
// that server's own name in `server`, the group the list draws it under. `argumentHint` is the
// provider's own hint for what follows the word, present only where the provider publishes one.
// `scope` is present only where the provider declares one (the Codex skills surface does, the
// Claude handshake enumeration does not), so its absence means the provider stated no scope rather
// than that the scope is unknown to the driver. `enabled` follows that same
// present-iff-the-provider-declares-one rule: the Codex `skills/list` entry carries an `enabled`
// Boolean ([Spec-004 §Per-Driver Capability
// Matrix](../../specs/004-provider-driver-contract-and-capabilities.md#per-driver-capability-matrix))
// and the Claude handshake enumeration publishes no enabled/disabled distinction at all, so ABSENT
// means the provider draws no such distinction on this surface — never that the entry's state is
// unknown to the driver, and never a driver-synthesized `true`, which would be exactly the
// fabricated reading the verbatim rules elsewhere in this section forbid. The driver DOES NOT
// FILTER: a disabled entry is returned, because dropping it would make the result stop being the
// provider's enumeration as observed, and a consumer would have no way to tell a disabled command
// from one that does not exist. What the flag governs is OFFERABILITY, not presence — an entry
// whose `enabled` is explicitly `false` is not offerable and is rendered unavailable rather than
// advertised as runnable, since the bound provider will not execute it; an absent `enabled` is
// offerable.
//
// THE LIST IS AN OFFER, NEVER A GATE. Picking an entry puts its own form into the composer: a
// provider's command or a skill as the word it is, a tool server's prompt as that prompt's text
// (read on Codex, which never asks a server for its prompts, through the daemon's own MCP client).
// A word the person types is sent as typed whether or not an entry matches it: a word on no list
// reaches the provider, which answers it as it does in its own terminal, so nothing here refuses
// text for starting with `/` and there is no literal-slash escape. The app's own words never reach
// a provider as text: most press a control the app already has, and six — `/goal`, `/review`,
// `/reload`, `/btw`, `/voice` and `/daybreak` — the daemon carries out itself through the
// provider's own feature (`/review` starts Codex's own review, or Claude Code's bundled code-review
// skill). The compaction command is one more the driver sends on its own, composed by the driver's
// emulated leg and reached through `compactContext`, which checks presence against this same
// enumeration and settles on typed evidence ([Spec-004 §Required
// Behavior](../../specs/004-provider-driver-contract-and-capabilities.md#required-behavior)).
//
// CHECKED AT THE NORMALIZE BOUNDARY. Every entry is assembled from provider-, skill- and
// tool-server-authored metadata — a local skill file's front matter is the person's to write, a
// provider handshake enumeration is provider-writable, and a tool server's prompt list is the
// server's. `name`, `description`, `scope`, `argumentHint` and `server` are therefore
// `FreeFormText<MAX>`-bounded (length + non-whitespace + NUL-rejection) exactly as the other
// untrusted provider-output strings enumerated at the head of this section are. The list carries
// every entry the provider publishes, with no count of the driver's own; the palette draws only the
// rows in view. The binding an enumeration belongs to: the driver, by its open provider id
// (`ProviderId`, checked against the registered drivers), and the account the session runs on.
interface ProviderCommandBinding {
  providerName: ProviderId;
  providerAccountId: string;
}
// Tagged on `kind`; only a tool server's prompt names its server and carries a title.
type ProviderCommandEntry =
  | ({ kind: "command" | "skill"; server?: never; title?: never } & ProviderCommandEntryMembers)
  | ({
      kind: "prompt";
      server: string; // the tool server that publishes it
      title?: string; // the prompt's title for people, where the server gives one
    } & ProviderCommandEntryMembers);
interface ProviderCommandEntryMembers {
  name: string;
  description?: string;
  argumentHint?: string;
  scope?: string;
  // Absent = the provider draws no enabled/disabled distinction on this surface. `false` = the
  // provider published the entry AND declared it disabled: returned, never filtered, not offerable.
  enabled?: boolean;
  binding: ProviderCommandBinding;
}

// One binding's enumeration, WHOLE: the driver's read and every emission of the session's
// subscription carry the complete list, never a patch, so a consumer is never handed a delta to
// apply and a new provider process yields a new list rather than an amended one.
interface ProviderCommandListResponse {
  binding: ProviderCommandBinding;
  entries: ProviderCommandEntry[];
}

// One emission of `session.providerCommand.subscribe` (running-command-payloads.md §Running-Command
// Method Registry): the list of the session's live provider process, whole — on the first frame, on
// each change the provider pushes (Claude Code's `commands_changed`, Codex's `skills/changed`), and
// again for each new process — with each working tool server's prompts. It names no binding: the
// daemon follows the session's live binding itself and never emits a list read under one the
// session has left.
interface SessionProviderCommandList {
  sessionId: SessionId;
  commands: ProviderCommandEntry[];
  serverPrompts: Array<{
    serverName: string;
    name: string;
    title?: string;
    description?: string;
  }>;
}

// The canonical transcript (ADR-027) is a PROJECTION the daemon rebuilds per call and caches
// nowhere; the hand-over brief's one-line notes, its word-for-word tail and its transcript file are
// read from it (Spec-004 §The Canonical Transcript And The Hand-Over Brief). No transcript is
// replayed into a fresh provider session, so no driver operation takes it. The daemon-side fold of
// a run's normalized events into ordered turns (Spec-004 §The canonical transcript is a projection,
// never a store). It never crosses a wire and is never persisted, so only its IDENTITY is mirrored
// here: the per-turn element shape is authored by Plan-003 T3.16 in
// `crates/sidekicks-provider/src/hand_over/canonical_transcript.rs` and is bounded by the
// Spec-005 normalized taxonomy, which is what makes "anything that never became an event is not in
// the transcript" true by construction rather than by discipline.
interface CanonicalTranscriptProjection {
  sessionId: SessionId;
  runId: RunId;
  // The log position this fold was taken at. Two folds at the same position render identically and
  // one taken after an appended event does not — the projection-not-a-store property, asserted.
  builtAtPosition: number;
  turns: readonly CanonicalTranscriptTurn[]; // element shape owned by Plan-003 T3.16, above
}

interface CreateSessionParams {
  sessionId: SessionId;
  config: Record<string, unknown>;
  // the session's model; a provider that takes it at process start applies it to this session
  // alone, one that takes it per turn reads it there
  model: string;
  // The larger window the session chose for its model, in tokens, recorded when it was picked;
  // `undefined` runs the model's default window (Spec-004 §Required Behavior). Required as a key so
  // no constructor can drop it. Codex sends it as the conversation's `model_context_window`, after
  // checking that the catalog still offers that figure for the model: a create whose figure the
  // catalog no longer offers is refused `agent.providerAxisInvalid` on its `largerWindow` axis,
  // since the picker row it came from was read before the catalog changed. Claude Code's model id
  // carries the window (`[1m]`), so its driver refuses a defined figure.
  largerWindow: number | undefined;
  // spawn-time posture — provider legs that bind posture at process spawn (Claude `--settings`
  // sandbox) realize it here; the per-run effective posture rides StartRunParams (Spec-004
  // §Required Behavior)
  executionPosture?: ExecutionPosture;
  // The agent's ACCEPTED accelerated-output mode (Spec-004 §The output-speed axis). Gated on the
  // `outputSpeed` flag, which Claude Code and Codex both declare. The person's request was
  // validated where it was made (`agent.config.update`, refusing an unlisted level with
  // `agent.providerAxisInvalid`); the driver refuses no carried level. It resolves it against the
  // session model's `ProviderModel.outputSpeedLevels` where its provider publishes one (Codex),
  // else the driver's declared `outputSpeedLevels` (Claude Code), and a level the model does not
  // list runs at standard and is never recorded as applied. Each provider takes it its own way:
  // Codex as a service tier on thread establishment and again on each turn; Claude Code through
  // `apply_flag_settings {fastMode}` sent after the spawn and again between turns when it changes,
  // from the next run, with no restart. It rides the create so the first turn already runs at it,
  // and `ResumeSessionParams` re-realizes it below. Requesting it is NOT the same as getting it —
  // what the provider actually declared is observed later as binding-held
  // `ProviderOutputSpeedState`.
  outputSpeed?: string;
  // daemon-curated callback-tool registry exposed into the session, served on the daemon's shared
  // `sidekicks` MCP tool server through one entry per session (Claude Code an in-process server
  // named in `initialize`'s `sdkMcpServers`, Codex a `url` entry in the conversation's
  // `mcp_servers` at `thread/start`), never Codex `dynamicTools`; gated on the callbackTools flag
  callbackTools?: SessionCallbackTool[];
  // provider-native in-session subagent policy pass-through under the single-supervisor invariant
  // (Spec-014 semantics); gated on the subagents flag
  subagentPolicy?: SubagentPolicy;
  // normalized JSON Schema constraining schema-constrained final output (Spec-004 §Per-Driver
  // Capability Matrix `structuredOutput`); gated on the structuredOutput flag. The Claude leg binds
  // it per session at spawn (--json-schema); the Codex leg realizes it per turn via
  // StartRunParams.outputSchema (turn/start.outputSchema). Named consumers: Plan-013 orchestration
  // reads
  outputSchema?: Record<string, unknown>;
  // Provider-account identity at spawn (Plan-003 T3.45), REQUIRED on every create and resume.
  // OPAQUE TO THE DRIVER — never parsed, and never used by the driver to read credential material
  // itself: the driver hands it back to the daemon, the Claude Code driver to receive the account's
  // spawn environment with its credential store pinned in (and the ambient names a bound leg must
  // not read denied), the Codex driver to receive the account's Codex home, whose app-server
  // service runs the session. That pinning is an obligation on the spawn path — Plan-023's
  // fail-closed binding, consumed per CP-003-7 — not a property this member carries. RESOLVED BY
  // THE DAEMON AND NEVER SUPPLIED BY A CLIENT: the daemon resolves exactly one account and stamps
  // it here — the account pinned by the run's saved agent definition or workflow step where one
  // pins, and otherwise the provider's current account, the one carrying the mark on the provider
  // surface when the run starts (provider-account-payloads.md §Plan-023 — Provider Accounts And
  // Credential Homes). No wire request carries an account per session or per run, so there is no
  // override to authorize and no client-supplied value to reconcile against the resolution.
  // Spawn-bound because a run's paying account is bound for the run's LIFETIME —
  // `ResumeSessionParams` re-realizes it below from the durable record rather than re-resolving
  // whichever account is current at the resume.
  // A provider with no account to resolve refuses the run before spawn
  // (`provider.account.notRegistered`, `provider.account.current.notSet`).
  providerAccountId: string;
  // THIS SESSION'S OWN bound on how many steps one turn may take, carried onto the spawn because
  // one leg realizes it as a start flag (Spec-003 §The Step Bound On A Turn). Absent means the
  // session set no bound of its own, in which case the machine's own Runtime value applies and
  // where that is unset each provider does what it does on its own. The driver carries the number
  // onto its own realization: the daemon's own per-turn count on every leg, which interrupts the
  // turn at the number, and on the Claude leg one more as `--max-turns`, a backstop. Spawn-bound
  // like posture and speed, so `ResumeSessionParams` re-realizes it below. Reaching the bound ends
  // the turn as `agent.turn.interrupted` with cause `stepLimit`, its partial result kept, and the
  // run rests `interrupted` with trigger `stepLimit` until a send, or `Continue`, carries it on
  // under the same run id. It is not a budget.
  maxStepsPerTurn?: number;
  // daemon-injected callback-tool dispatcher; the driver invokes it on a provider callback-tool
  // request and answers the provider with the result. Gated on the callbackTools flag; the
  // daemon-side host routes through Plan-009's Cedar pipeline (CP-003-5 / Plan-009 T2.8). See
  // CallbackToolInvocation in provider-driver-capability-payloads.md
  onCallbackToolCall?: (invocation: CallbackToolInvocation) => Promise<CallbackToolResult>;
  // daemon-injected MCP server-status sink; the driver emits the per-session MCP server-status
  // census (init) + status-change updates through it as typed McpServerStatusEmission values — the
  // closure is pre-bound to the leg identity (sessionId + bindingId) at spawn and stamps them into
  // the consumer-facing McpServerStatusUpdate. Producer-only at Plan-003 — the consumer is
  // Plan-022's status normalizer (mcp-governance-payloads.md §Plan-022 — MCP Governance Contract
  // Surfaces; Spec-024). See McpServerStatusEmission in provider-driver-capability-payloads.md
  onMcpServerStatus?: McpServerStatusProducer;
}

interface ResumeSessionParams {
  sessionId: SessionId;
  resumeHandle: string; // opaque provider-owned handle
  // the session's current model, supplied by the caller: a model switch after the spawn moves the
  // session, so the spawn-time value would be stale
  model: string;
  // The session's recorded larger window, sent as recorded whatever the catalog offers now: the
  // session keeps the window it chose, and a figure the provider refuses fails the resume like any
  // other provider failure rather than resuming on the default. The Claude Code driver refuses a
  // defined figure, as on create.
  largerWindow: number | undefined;
  // Resume is a FRESH process spawn (the C-12 posture-relaunch precedent), so every spawn-bound
  // surface CreateSessionParams binds must re-realize here or the resumed leg silently sheds it — a
  // posture-less resume relaunches UNSANDBOXED, a schema-less one unconstrained. The DATA legs
  // below are reconstructed by the daemon from the durable runtime_bindings.spawn_config record
  // (written at every spawn; Plan-003 T1.6) — never from the original client request, which
  // recovery does not have; the two FUNCTION legs are re-injected fresh at every spawn (functions
  // are never stored in spawn_config).
  executionPosture?: ExecutionPosture;
  // The requested mode, re-realized on the fresh process. It is a reconstructed leg of spawn_config
  // for exactly the reason posture is: a speed-less resume relaunches at the provider's default
  // while `agents.output_speed` still records the person's accepted choice, which is the
  // silent-shedding failure this list exists to prevent. What the relaunched process declares is
  // observed as binding-held `ProviderOutputSpeedState` (the reason is given on
  // `ProviderSessionHandle` in provider-driver-capability-payloads.md), never returned on
  // `DriverResumeResult`, so a mode that stops being available across a restart surfaces as an
  // observation rather than as a stale request. A recorded mode the model no longer lists resumes
  // at standard instead of failing the resume, and the observation then reads standard.
  outputSpeed?: string;
  callbackTools?: SessionCallbackTool[];
  subagentPolicy?: SubagentPolicy;
  // the Claude leg re-binds per session at spawn (--json-schema); the Codex leg realizes per turn
  // via StartRunParams.outputSchema
  outputSchema?: Record<string, unknown>;
  // A reconstructed data leg (T3.45) — the one whose silent shedding is a BILLING fault rather than
  // a capability one: a resume that re-resolved "whichever account is current now" would move a
  // live run's spend onto an account it was never admitted against, mid-run, with the receipt's
  // per-paying-account key still claiming the original. Moving the current account moves a live
  // SESSION in place at its next request, the cost splitting at the provider's acknowledgment —
  // never by re-resolving this stamp at a resume. The session's own total keeps counting across
  // that move: the requests before it stay under the account they ran on, the requests after it
  // under the new one, and the receipt carries both as account rows summing to one total. Read back
  // from the durable `runtime_bindings.spawn_config` record written at the original spawn — never
  // re-resolved, and never re-supplied: no wire request carries an account, and recovery holds none
  // to take one from. Same opacity rule as on `CreateSessionParams` above.
  providerAccountId: string;
  // A reconstructed data leg: a resume that dropped the session's own step bound would relaunch the
  // Claude leg without its `--max-turns` backstop while the session record still holds the number
  // the person set, which is the silent shedding this list exists to prevent. Read back from
  // `runtime_bindings.spawn_config` like its siblings, never re-read from the session record at the
  // resume, so a bound changed mid-run reaches the next turn rather than the relaunch.
  maxStepsPerTurn?: number;
  // re-injected dispatcher — an omitted rebind would strand provider callback-tool requests
  // unanswered on the resumed leg
  onCallbackToolCall?: (invocation: CallbackToolInvocation) => Promise<CallbackToolResult>;
  // re-injected census sink, pre-bound to the resumed leg's identity — the resumed leg re-emits its
  // init census through it
  onMcpServerStatus?: McpServerStatusProducer;
  // The timed fires the idle sleep stored for the session — its wake-ups and the scheduled jobs
  // that live only in the session's process — read from the daemon's store by the session's key
  // on every resume, empty for a session with none. A fresh process holds none of them, so a
  // session the idle sleep put to sleep, woken after a daemon restart, takes them back here.
  keptSchedules: KeptSchedule[];
}

interface StartRunParams {
  runId: RunId;
  agentConfig: Record<string, unknown>;
  conversationHistory?: unknown[];
  // per-run effective posture — the same object the daemon stamps on agent.run.running (Spec-005
  // §Run Lifecycle). Codex realizes per-turn (turn/start sandbox params); a provider that binds
  // posture at spawn realizes it at session boundaries, and a mid-session posture change on such a
  // leg resolves via session relaunch, never silent partial application (Spec-004 §Required
  // Behavior)
  executionPosture?: ExecutionPosture;
  // per-turn schema-constrained final output (Codex turn/start.outputSchema); the Claude leg binds
  // it at spawn via CreateSessionParams.outputSchema (--json-schema). Gated on structuredOutput
  // (Spec-004 §Per-Driver Capability Matrix)
  outputSchema?: Record<string, unknown>;
  // the agent's accepted output-speed level, carried on each run; Codex sends it as the turn's
  // serviceTier, Claude Code applies it before the turn only when it differs from the level the
  // process holds
  outputSpeed?: string;
  // a level for this run's turn alone, such as standard for `Use standard` after a flex-capacity
  // failure; Codex sends it as turn/start.serviceTierForTurn ("default" for standard), and the next
  // run carries the agent's own level again
  outputSpeedForTurn?: string;
}

interface InterruptRunRequest {
  runId: RunId;
  reason?: string;
}

// Discriminated union over `type` — each intervention type coupled to its payload shape.
// `expectedRunVersion` is the MANDATORY fail-closed comparand (Plan-002 D-002-2) repeated on every
// arm — absent value rejected, never applied. `clientIdempotencyKey` is the MANDATORY
// requester-generated UUID (Spec-004 §Required Behavior): the daemon dedupes on it
// (return-or-conflict), and it rides through to the driver so provider-remote invocations that
// honor dedupe keys receive it (the `compensable` propagation pattern, Spec-004 §Tool Metadata).
// Same field set as the interrupt arm of the AgentRunInterveneRequest union in
// run-control-payloads.md; its `fasterModelRetry` arm never reaches the driver, because the daemon
// carries it out. The `steer` arm here is the queue's delivery of a waiting message through the
// driver's own steer (Plan-002 T3.8); no client sends one. Undo is not an intervention: it is
// `session.restore`, whose conversation leg reaches the driver through `rewindConversation`
// ([Spec-013 §Interfaces And
// Contracts](../../specs/013-persistence-and-recovery.md#interfaces-and-contracts)).
type ApplyInterventionParams =
  | {
      type: "steer";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      payload: SteerPayload;
    }
  | {
      type: "interrupt";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      payload: InterruptPayload;
    };

// The ATTACHMENT-CARRIER contract, stated once here and cited from
// `AgentQueueItemCreateRequest.attachments` (`agent.queueItem.create`) in run-control-payloads.md
// §Plan-002. The element type is ArtifactId — an id into Spec-012's manifest space, never an
// untyped element and never an inline byte payload; caller bytes enter through the
// boundary-validated ingest paths instead. [Spec-012 §Required
// Behavior](../../specs/012-artifacts-files-and-attachments.md#required-behavior) states that
// encoding
//: an RFC 9562 UUID the daemon mints at manifest creation, carried distinctly from the
// payload's SHA-256 digest — which is what makes an element REFUSABLE at this parse boundary rather
// than only at resolution time. Caller-declared ORDER is preserved end to end, and an element the
// turn cannot resolve or deliver surfaces as an explicit cause-bearing unresolved marker IN ITS
// DECLARED POSITION — silently dropping it is prohibited (Plan-011 I-011-5, Spec-012 §Fallback
// Behavior). Neither property is a parse concern; what the untyped arm could not do at all was
// carry an id a resolver could look up, so the rule had nothing to attach to and CP-011-1 made the
// retyping a PREREQUISITE of the first change that wires delivery through this carrier. The carrier
// sets no count bound of its own: how many files a message carries is what the daemon and the
// provider accept, and a provider that will not take one refuses in its own words. The brand lives
// in `crates/sidekicks-contracts/src/artifacts/id.rs` per Plan-003 CP-003-4, and this payload and
// every later consumer import it (`ArtifactId`); Plan-011 Task 1 imports rather than restates, so
// no second definition of an artifact id exists.
interface SteerPayload {
  content: string;
  attachments?: ArtifactId[];
  // The skills the person picked for this message, each as its provider listed it: its name and the
  // absolute path of the `SKILL.md` file Codex's own `skills/list` gave for that name in the folder
  // picked. The daemon resolves a pick to it, so no path a client sent reaches a provider; a Codex
  // agent receives each as its own skill input item, and a Claude Code session carries none, its
  // agent reading the `/name` the composer put in `content`.
  skills?: PickedSkill[];
  expectedTurnId?: string;
}

interface PickedSkill {
  name: string;
  path: string;
}

interface InterruptPayload {
  // the waiting messages go as the next turn, back to the draft, or keep waiting (the daemon's own
  // interrupt at a limit, which no wire request carries)
  pending: "nextTurn" | "returnToDraft" | "keepWaiting";
  reason?: string;
}

interface ApplyInterventionResponse {
  // the complete driver-level vocabulary — `rejected` / `expired` are orchestration-layer verdicts
  // rendered around driver dispatch, never driver-returned (Spec-004 §Required Behavior; normative
  // mapping in queue-and-intervention-model.md §Driver Result To Lifecycle Mapping)
  status: "applied" | "degraded";
  // names the fallback the orchestration layer took, present only on `degraded`
  fallbackAction?: string;
  // a delivered message's run when that is not its target: settling a choice the target was held on
  // ended it, so the message started the session's next turn as a run of its own
  deliveredRunId?: RunId;
  // the waiting messages an interrupt took back from the provider, none of which runs: the ids of
  // its receipt that read as queue items, any other dropped
  cancelled: string[];
}

// The MOVE ONTO A FORK: the driver starts a new provider conversation from the bound one's history
// at a message, never writing to the conversation it forked, and moves the session itself onto it;
// each provider's mechanism is Spec-004's. It is not `session.fork`, which mints a new session and
// leaves the source running untouched
// ([§Plan-001 — Session Core](./session-payloads.md#plan-001--session-core)). It is never a
// rollback: undo cuts the conversation IN PLACE through `rewindConversation`.
interface MoveSessionToForkParams {
  sessionId: SessionId;
  // the normalized session position of the message the fork carries history up to and including;
  // the driver maps it to its provider's own anchor
  position: number;
  // the session's leg — the run's live runtime binding, daemon-resolved at dispatch (run→bindings
  // is 1:many, so `sessionId` alone cannot name it); no client payload carries it
  bindingId: string;
}

type MoveSessionToForkResult =
  // `sessionPosition`: the driver-confirmed position the forked conversation ends at. Before the
  // result returns, the driver has pointed that binding at the forked conversation and
  // recorded the conversation it left, in one write; the result carries no binding of its own.
  { status: "applied"; sessionPosition: number } | { status: "degraded"; fallbackAction?: string };

// The conversation CUT is `rewindConversation`: undo's conversation leg, in place on the run's own
// live runtime binding, reached through `session.restore` with a scope that includes the
// conversation. It targets a message identity, never a numeric or provider position; any position
// the provider needs stays inside the driver. Files are never the driver's: they are the daemon's
// per-session file checkpoint store ([Spec-013 §Required
// Behavior](../../specs/013-persistence-and-recovery.md#required-behavior)). `agent.run.rolledBack`
// records the cut. Its parameter and result shapes and each provider's mechanism are
// daemon-internal ([Spec-004 §Interfaces And
// Contracts](../../specs/004-provider-driver-contract-and-capabilities.md#interfaces-and-contracts)).

// Goal delivery. A goal is a command sent to one agent, never what the session is: `goalText` is
// the condition the person typed after `/goal` (not blank, no NUL, no length cap of the app's own),
// sent to the agent the command targets. Codex leg: `thread/goal/set` / `thread/goal/clear` (the
// `objective` field), live, each with `origin: "user"`, the person's own act. Claude Code leg: its
// own `/goal <condition>` and `/goal clear`, sent as user messages. Neither leg writes goal text
// into a system prompt. The provider checks the goal each time the agent would stop, and the daemon
// folds what each provider reports into `session.goal.updated`, whose status is one of `active`,
// `paused`, `blocked`, `usageLimited`, `budgetLimited`, `complete` or `impossible` (`complete` and
// `impossible` are final; only Claude Code sends `impossible`, with its reason); clearing is
// `session.goal.cleared`, never a status (Spec-005; [Spec-014 §Session
// Goals](../../specs/014-multi-agent-orchestration.md#session-goals)). Durable truth is those
// events; driver-held state is never the recovery source.
interface SetSessionGoalParams {
  sessionId: SessionId;
  // Leg addressing: the goal goes to the target agent's live binding, and `run` → bindings is
  // 1:many in the store (store-minted surrogate ids; e.g. a posture relaunch mints a new binding
  // for the same run) — so the BINDING is the leg key. The driver resolves its provider session
  // from the binding it established at createSession/resumeSession (DriverResumeResult already
  // returns bindingId); runId rides along for run-scoped context and telemetry.
  bindingId: string;
  runId: RunId;
  goalText: string;
}

interface ClearSessionGoalParams {
  sessionId: SessionId;
  bindingId: string; // leg key — the same leg addressing as SetSessionGoalParams
  runId: RunId;
}

type DriverGoalResult =
  // `applied` = the provider took the goal for the target agent (both V1 legs deliver it natively)
  // — a fallback narrative on a successful application is unrepresentable.
  | { status: "applied" } // success carries no fallback field
  | { status: "degraded"; fallbackAction?: string }; // the provider did not take the goal

// Return shape of `ProviderDriver.resumeSession()`. Discriminated union over `status` makes
// silent-replacement structurally inexpressible: the failure variant has no `bindingId`, so a
// successful resume cannot be conflated with a failed one. Spec-004 §Fallback Behavior requires
// that resume failure "surface `providerFailure` detail and a visible `recoveryNeeded` condition;
// it must not silently create a replacement provider session under the same canonical run." After a
// `resumed` result the daemon compares the provider's record with its own by provider id at the
// grain of each step; divergence reconciliation (halt-for-human, rollback markers as the floor) is
// Spec-013's, per ADR-016's rule that the local log is authoritative. The driver reports `resumed`
// only for the provider session its handle names, so a provider silently returning a fresh session
// on resume (e.g. Claude on a working-directory mismatch) is caught: Codex refuses a
// `thread/resume` reply naming another thread, and Claude Code's first `system/init` after a resume
// naming another session fails the run with `providerFailure` and `recoveryNeeded` before any row
// of that turn is written. Timestamps for the resumed case live on
// `runtime_bindings.updated_at` (Plan-003 T2.1); the result shape carries only the
// discriminated-union semantic payload.
type DriverResumeResult =
  // NO `outputSpeedState` MEMBER, and its absence is deliberate rather than an omission: as on
  // `ProviderSessionHandle`, the provider's declared speed state changes over the binding's life,
  // so a resume return would hold a snapshot the next declaration makes stale. What the relaunched
  // process declares is held as the binding-held state `ProviderOutputSpeedState` in
  // provider-driver-capability-payloads.md defines.
  | {
      status: "resumed";
      bindingId: string;
      // The conversation the session runs on now, which the daemon records on the binding: the
      // handle it was given, or a new one where the provider continues the conversation in a new
      // thread, as Codex does, reopening a conversation by forking it with the session's whole
      // config, since a resume of one another client holds applies none of it.
      resumeHandle: string;
    }
  | {
      status: "failed";
      recoveryCondition: RecoveryCondition;
      providerFailureDetail: string;
    };

// Named once, referenced at every carrying surface: REQUIRED form on `DriverResumeResult.failed`
// above; optional form on `RunStateChangeEvent` (run-control-payloads.md) and
// `DaemonRecoveryStatus.sessions[]` (persistence-payloads.md). `recoveryNeeded` = generic, the
// person must reconcile. `reauthRequired` = the provider session or credential expired (detected
// mid-run via the provider's typed auth-failure signals or at resume/probe time); remediation is
// re-authenticating the provider CLI on the machine, after which recovery may retry (Spec-004
// §Fallback Behavior). A resume that cannot load fails the run with its recovery failure detail;
// one whose provider record holds more than the daemon's, beyond reads, halts the run in
// `waitingForInput` with `recoveryNeeded` for the person's choice (Spec-013 §Fallback Behavior). No
// transcript is replayed into a fresh provider session (Spec-004 §Required Behavior).
type RecoveryCondition = "recoveryNeeded" | "reauthRequired";

// Typed provider usage-limit signal (Plan-003 T3.44). A SIBLING AXIS beside `RecoveryCondition`
// above, never a member of it — that axis names why a run needs the person; this one names an
// allowance state the provider reported, minted here and scoped per-account by Plan-023 keying on
// `(accountId, credentialGeneration)` (CP-003-6 ⇄ CP-023-2). Recognition is TYPED-ONLY (I-003-6):
// each driver leg keys on a structured provider event it can name — never message prose, an exit
// code, or a bare HTTP status — and an unrecognized shape emits NOTHING, an absence that reads "not
// known to be limited", never "known not to be limited". The signal is a wire shape, so its Rust
// type lives in `crates/sidekicks-contracts` (`provider/driver/usage_limit.rs`, which Plan-003
// T3.44 EXTEND creates; the generated TypeScript keeps
// `packages/contracts/src/provider/driver/usage-limit.ts`), beside `RecoveryCondition`'s: it rides
// `agent.run.failed`'s `failureCause` (Spec-005 §Run Lifecycle), where a reload redraws the limit
// row from the stored record, and the workflow park reads the same shape. No member is
// provider-verbatim — `cause` is a closed literal the driver selects and `resetsAt` a timestamp it
// composes — so the schema checks what the record carries, not the provider's words.

// One cause, plan-allowance exhaustion. The neighbor conditions (Codex workspace/member credit
// depletion and the Codex spend-control ceiling, Claude billing faults) are account-plane or
// payment facts rather than plan-allowance exhaustion, each named in the contracts file rather than
// absorbed here.
type ProviderUsageLimitCause = "planAllowanceExhausted";

// The reset instant, when the provider gave one. Primary sources, per the AGENTS.md citation
// standard: the Codex leg reads it off the published rate-limit shapes — the
// `account/rateLimits/read` pull + `account/rateLimits/updated` push pair the provider-wire
// reference family's codex file records (Generated schema, Verified at the version that file
// names), consumed by the codex event-normalizer's push row. The Claude leg emits no
// usage-limit signal: Claude Code retries no plan limit, so its final announced `api_retry`
// of a `rate_limit` or `overloaded` error is the spent-retries cause, `retriesExhausted`,
// with no reset boundary — the mid-session retry taxonomy the provider-wire claude file
// records (Binary probe, Verified at Claude Code 2.1.245). The sibling-axis rule and
// typed-only recognition are `Spec-004 §Fallback Behavior`'s.
interface ProviderUsageLimitResetBoundary {
  resetsAt: string; // RFC 3339 UTC — the encoding `WorkflowStep.resumeAt` already consumes
}

// The signal itself. The BOUNDARY IS OPTIONAL AND THE CAUSE IS NOT: a limit can be recognized
// with no reset instant to report, but never without a cause.
interface ProviderUsageLimitSignal {
  cause: ProviderUsageLimitCause;
  resetBoundary?: ProviderUsageLimitResetBoundary;
}

interface RespondToRequestParams {
  runId: RunId;
  requestId: string;
  response: unknown;
}

interface OverrideDenialParams {
  sessionId: SessionId;
  // The provider's own denial the daemon kept with the block: Claude Code's action as its
  // `PermissionDenied` hook received it, or Codex's review as Codex sent it.
  providerDenial: unknown;
}

interface CloseSessionParams {
  sessionId: SessionId;
}
```
