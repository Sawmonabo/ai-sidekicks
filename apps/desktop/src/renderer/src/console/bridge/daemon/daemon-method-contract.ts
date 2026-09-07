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
  ProviderCommandListResult,
  ListProviderCommandsRequest,
  ListModelsResult,
  ListCapabilitiesResult,
  InterruptRunParams,
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
  InviteRevoke,
  InviteRevokeResponse,
  MembershipUpdate,
  MembershipUpdateResponse,
  PresenceReadRequest,
  PresenceReadResponse,
  ProviderAccountListRequest,
  ProviderAccountListResponse,
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
  readonly "invite.revoke": {
    readonly request: InviteRevoke;
    readonly response: InviteRevokeResponse;
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
}
