// The console's registered daemon call set: which methods, and which shapes.
//
// The declaration half of the reply registry beside it. `daemon-reply-registry.ts`
// owns why the registry exists, how a shape is bound to a method, and the frozen
// table a call resolves through; this owns WHAT IS IN THE SET, which is the half a
// surface's author reads and the half a landing family adds a row to. They are split
// because together they were one file past the package's ceiling, and the seam is the
// one place the two halves do not overlap: nothing here binds a schema, and nothing
// there names a method's shape.

import type {
  ChildRunExpandRequest,
  ChildRunExpandResponse,
  ProviderCommandListResult,
  ListProviderCommandsRequest,
  ListModelsResult,
  ListCapabilitiesResult,
  InterruptRunParams,
  ReasoningSurfaceReadRequest,
  ReasoningSurfaceReadResponse,
  RespondToRequestParams,
  DriverReadParams,
  DriverCompactionResult,
  DriverAckResult,
  CompactContextRequest,
  ChannelListRequest,
  ChannelListResponse,
  ExecutionModeSelectRequest,
  ExecutionModeSelectResponse,
  InterventionRequestPayload,
  InterventionRequestResponse,
  InviteCreate,
  InviteCreateResponse,
  InviteRevoke,
  InviteRevokeResponse,
  MembershipUpdate,
  MembershipUpdateResponse,
  PresenceReadRequest,
  PresenceReadResponse,
  ProviderAccountListRequest,
  ProviderAccountListResponse,
  ProviderAccountProbeRequest,
  ProviderAccountProbeResponse,
  QueueItemCancelRequest,
  QueueItemCancelResponse,
  QueueItemCreateRequest,
  QueueItemCreateResponse,
  QueueItemListRequest,
  QueueItemListResponse,
  EphemeralCloneDisposeRequest,
  EphemeralCloneDisposeResponse,
  EphemeralClonePrepareRequest,
  EphemeralClonePrepareResponse,
  ExecutionRootPrepareRequest,
  ExecutionRootPrepareResponse,
  RepoAttachRequest,
  RepoAttachResponse,
  RepoMountReadRequest,
  RepoMountReadResponse,
  RunControlAck,
  RunPauseRequest,
  RunResumeRequest,
  SessionCreateRequest,
  SessionCreateResponse,
  SessionJoinRequest,
  SessionJoinResponse,
  TimelineReadRequest,
  TimelineReadResponse,
  WorkspaceExecutionModeCapabilitiesReadRequest,
  WorkspaceExecutionModeCapabilitiesReadResponse,
  WorkspaceBindRequest,
  WorkspaceBindResponse,
  WorkspaceListRequest,
  WorkspaceListResponse,
  WorktreeRetireRequest,
  WorktreeRetireResponse,
  WorktreeReuseCheckRequest,
  WorktreeReuseCheckResponse,
  WorktreeStatusReadRequest,
  WorktreeStatusReadResponse,
} from "@ai-sidekicks/contracts";

/**
 * What one call does on the far side.
 *
 * TWO ARMS AND NO THIRD. A method that reads and writes is a RECORD: the question this
 * answers is whether the call may be dispatched through a supervisor that is not
 * serving (`Spec-023 §Daemon Supervision Lifecycle` step 3 blocks mutating operations
 * and keeps read-only subscriptions live), and a call that writes anything may not.
 *
 * HERE RATHER THAN AT THE REGISTRY, beside the method set it is a fact about: a
 * method's kind is part of WHAT it is, which is this module's half, while binding a
 * schema to it is the registry's. The VALUE for each method rides that registry's own
 * row, so the classification is a column the same annotation already makes mandatory
 * rather than a second list of these method strings.
 *
 * A method's NAME is not its kind, which is why each row's value is quoted from the
 * operation's own `query` / `mutation` cell in
 * `docs/architecture/contracts/api-payload-contracts.md`: `repo.worktreeReuseCheck`
 * ends in a word that reads like a write and is a `query`, `providerAccount.probe`
 * reads like a read and writes the probed account's health row and its credential
 * generation, and `driver.respondToRequest` names neither direction.
 */
export type DaemonMethodKind = "read" | "record";

/**
 * Every registered daemon method a console surface calls, bound to the request it
 * sends and the response the corpus registers for it.
 *
 * Keyed by the method STRING rather than by a symbolic name, so a call site spells
 * the wire's own word and `ConsoleDaemonMethodContract[MethodName]` resolves for a
 * generic parameter. The method strings are quoted verbatim from
 * `docs/architecture/contracts/api-payload-contracts.md`; nothing here invents one.
 *
 * Grouped by namespace, and within a namespace in the registry table's own row
 * order, so a reader comparing the two reads them top to bottom.
 */
export interface ConsoleDaemonMethodContract {
  // run — the queue and the five run controls that reach the wire as calls.
  readonly "run.queueCreate": {
    readonly request: QueueItemCreateRequest;
    readonly response: QueueItemCreateResponse;
  };
  readonly "run.queueList": {
    readonly request: QueueItemListRequest;
    readonly response: QueueItemListResponse;
  };
  readonly "run.queueCancel": {
    readonly request: QueueItemCancelRequest;
    readonly response: QueueItemCancelResponse;
  };
  readonly "run.pause": { readonly request: RunPauseRequest; readonly response: RunControlAck };
  readonly "run.resume": { readonly request: RunResumeRequest; readonly response: RunControlAck };
  /** Steer, interrupt, cancel, rollback: one method, four arms of one payload union. */
  readonly "run.intervene": {
    readonly request: InterventionRequestPayload;
    readonly response: InterventionRequestResponse;
  };

  // driver — the five client-facing verbs a composer, a run control, or a picker
  // reaches, registered together because they are one plane rather than five
  // decisions. Two of the replies are the empty object and one of the requests is:
  // that is a SHAPE the corpus publishes, so a reply arriving with members is a
  // protocol mismatch this console would otherwise read as a successful stop.
  // `DriverReadParams` is that published empty request and appears on three rows
  // rather than under three aliases, because the corpus registers one params type
  // for every no-argument driver read. `compactContext` is run-addressed and
  // `listProviderCommands` agent-addressed — an agent can hold several live bindings
  // and the daemon fans out, which is why the reply's groups carry the
  // `(driverName, providerAccountId)` each entry was read under — and both replies
  // are unions whose refused and failed arms are DATA a surface branches on rather
  // than rejections it catches. The command enumeration is a live read held for the
  // caller's current target and nothing longer; there is no registry behind it.
  readonly "driver.interruptRun": {
    readonly request: InterruptRunParams;
    readonly response: DriverAckResult;
  };
  readonly "driver.compactContext": {
    readonly request: CompactContextRequest;
    readonly response: DriverCompactionResult;
  };
  readonly "driver.listProviderCommands": {
    readonly request: ListProviderCommandsRequest;
    readonly response: ProviderCommandListResult;
  };
  readonly "driver.listCapabilities": {
    readonly request: DriverReadParams;
    readonly response: ListCapabilitiesResult;
  };
  readonly "driver.listModels": {
    readonly request: DriverReadParams;
    readonly response: ListModelsResult;
  };
  // The answer to a provider-raised ask. The one row whose `response` is `unknown` by
  // contract and deliberately so: the ask's own choice set or the participant's free
  // text both travel this member, which is why the input-ask card mints no wire of its
  // own. `DriverAckResult` is the reply — an acknowledgement that the answer reached
  // the driver, never a settlement of the ask, which only the ask's own row may state.
  readonly "driver.respondToRequest": {
    readonly request: RespondToRequestParams;
    readonly response: DriverAckResult;
  };

  // timeline — the run-scoped reasoning surface, whose reply is the CLOSED four-arm
  // availability discriminant. It is here rather than on the growth port because the
  // corpus registers both shapes: the admission rule the reply registry states is met
  // in all three conjuncts, and a growth row for a registered wire would be a second
  // answer to a method that already has one.
  readonly "timeline.reasoningSurfaceRead": {
    readonly request: ReasoningSurfaceReadRequest;
    readonly response: ReasoningSurfaceReadResponse;
  };

  // repo — the mounts, workspaces, and execution roots the repos section reads AND
  // mutates. One namespace and two registry tables behind it: the six mount-and-
  // workspace rows and the seven worktree-and-clone rows are registered in
  // `docs/architecture/contracts/api-payload-contracts.md` §Repo Method-Name Registry
  // (Tier 6) as one `repo` root, and the rows below are in those tables' own order.
  //
  // TWELVE OF THE THIRTEEN. `repo.detach` is the one registered method this console
  // deliberately does not bind, and its absence is a rule rather than a gap:
  // `Spec-009 §Detach Semantics (V1 Definition)` gives the desktop renderer no detach
  // surface in V1, so binding the shape would make the call one import away from a
  // surface that must not offer it. The mount card DISCLOSES where detach lives
  // instead of being silent about it.
  readonly "repo.attach": {
    readonly request: RepoAttachRequest;
    readonly response: RepoAttachResponse;
  };
  readonly "repo.mountRead": {
    readonly request: RepoMountReadRequest;
    readonly response: RepoMountReadResponse;
  };
  readonly "repo.workspaceBind": {
    readonly request: WorkspaceBindRequest;
    readonly response: WorkspaceBindResponse;
  };
  readonly "repo.executionModeCapabilitiesRead": {
    readonly request: WorkspaceExecutionModeCapabilitiesReadRequest;
    readonly response: WorkspaceExecutionModeCapabilitiesReadResponse;
  };
  readonly "repo.workspaceList": {
    readonly request: WorkspaceListRequest;
    readonly response: WorkspaceListResponse;
  };
  readonly "repo.executionModeSelect": {
    readonly request: ExecutionModeSelectRequest;
    readonly response: ExecutionModeSelectResponse;
  };
  readonly "repo.executionRootPrepare": {
    readonly request: ExecutionRootPrepareRequest;
    readonly response: ExecutionRootPrepareResponse;
  };
  readonly "repo.worktreeReuseCheck": {
    readonly request: WorktreeReuseCheckRequest;
    readonly response: WorktreeReuseCheckResponse;
  };
  readonly "repo.ephemeralClonePrepare": {
    readonly request: EphemeralClonePrepareRequest;
    readonly response: EphemeralClonePrepareResponse;
  };
  readonly "repo.ephemeralCloneDispose": {
    readonly request: EphemeralCloneDisposeRequest;
    readonly response: EphemeralCloneDisposeResponse;
  };
  /**
   * The worktree plane's one mutation the console sends. Bound because the sidebar's
   * bulk retire is its caller — a row bound ahead of a caller is the shape this
   * registry's own header forbids, and this one arrives with the surface that sends it.
   */
  readonly "repo.worktreeRetire": {
    readonly request: WorktreeRetireRequest;
    readonly response: WorktreeRetireResponse;
  };
  readonly "repo.worktreeStatusRead": {
    readonly request: WorktreeStatusReadRequest;
    readonly response: WorktreeStatusReadResponse;
  };
  // session, channels, membership, presence, invites — the collaboration plane.
  readonly "session.create": {
    readonly request: SessionCreateRequest;
    readonly response: SessionCreateResponse;
  };
  readonly "session.join": {
    readonly request: SessionJoinRequest;
    readonly response: SessionJoinResponse;
  };
  readonly "channel.list": {
    readonly request: ChannelListRequest;
    readonly response: ChannelListResponse;
  };
  readonly "membership.update": {
    readonly request: MembershipUpdate;
    readonly response: MembershipUpdateResponse;
  };
  readonly "presence.read": {
    readonly request: PresenceReadRequest;
    readonly response: PresenceReadResponse;
  };
  /**
   * Mint one invitation, and hand back its plaintext token exactly once.
   *
   * The reply is the only moment the token exists outside the control plane — only
   * its hash is persisted — so the surface that calls this is the surface that has
   * to reveal the link, and no later read can recover it.
   */
  readonly "invite.create": {
    readonly request: InviteCreate;
    readonly response: InviteCreateResponse;
  };
  readonly "invite.revoke": {
    readonly request: InviteRevoke;
    readonly response: InviteRevokeResponse;
  };

  // timeline — the child-run expansion, and the backward read window.
  //
  // The live stream is the store's own subscription rather than a call, so it is not
  // here. The READ is, and only in one direction: a session's stream replays from the
  // position this participant was last acknowledged at, so the store's log grows at
  // the tail on its own and has no way at all to reach what came before that
  // position. `beforeCursor` is what asks for it.
  readonly "timeline.childRunExpand": {
    readonly request: ChildRunExpandRequest;
    readonly response: ChildRunExpandResponse;
  };
  /**
   * One bounded window of rows BEFORE a position the console already holds.
   *
   * The forward direction of this same method is deliberately not a caller here: the
   * subscription already delivers it, and a second forward reader would be a second
   * source of truth for a log the reconciler orders. What the ledger's head control
   * sends carries `beforeCursor`, and the reply's own `hasMore` — never a page's
   * fullness and never a cursor's absence — is what says whether rows remain behind
   * it.
   */
  readonly "timeline.read": {
    readonly request: TimelineReadRequest;
    readonly response: TimelineReadResponse;
  };

  // providerAccount — the node-local registry read. The subscription beside it is a
  // stream and so is not here; see this module's header.
  /**
   * Live. `provider-account-quota.ts` calls it and the composer's accessory rail
   * renders the reading, so the row is bound by a caller rather than ahead of one.
   * The run-start account selector
   * `Spec-023 §Provider Accounts And Cost View (→ Plan-029 Provider Accounts And Credential Homes)`
   * puts on the composer is a second reader of the same registry, not the first.
   */
  readonly "providerAccount.list": {
    readonly request: ProviderAccountListRequest;
    readonly response: ProviderAccountListResponse;
  };
  /**
   * Live. The onboarding provider-readiness step's re-check control calls it: the
   * readiness `providerAccount.list` serves is read from a STORED observation, so a
   * person who has just signed a provider in out-of-band needs a way to ask again,
   * and re-reading the registry would only re-serve the same stored reading.
   *
   * It is a MUTATING verb by the account plane's own reckoning — it writes back the
   * health state and its timestamp, and crosses `credentialGeneration` where the
   * probe changes an account's authenticated-ness — so the step offers it as a
   * deliberate act and never on a cadence. This console reads nothing from its reply
   * except that it settled; the readiness that follows is the registry read's.
   */
  readonly "providerAccount.probe": {
    readonly request: ProviderAccountProbeRequest;
    readonly response: ProviderAccountProbeResponse;
  };
}
