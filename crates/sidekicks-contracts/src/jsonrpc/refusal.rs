//! The refusal codes: every `data.type` a refusal carries, each with the HTTP status a control
//! plane route answers it with. TypeScript gets them as one string union.

use serde::{Deserialize, Serialize};

use crate::typescript::TypeScriptModule;

/// Declares [`RefusalCode`] from one line per code: its variant, its wire text and, in
/// parentheses, its HTTP status, empty for a code that rides only the daemon's JSON-RPC wire.
macro_rules! refusal_codes {
    ($($(#[doc = $doc:literal])+ $variant:ident = $code:literal ($($status:literal)?);)+) => {
        /// A refusal's code, the `data.type` of a JSON-RPC error and the `code` of an HTTP error.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum RefusalCode {
            $(
                $(#[doc = $doc])+
                #[serde(rename = $code)]
                $variant,
            )+
        }

        impl RefusalCode {
            /// The TypeScript module the refusal union is written into.
            pub const TYPESCRIPT_MODULE_PATH: &str = "jsonrpc/refusal";

            /// Every code, in the order the TypeScript union lists them.
            pub const ALL: &[Self] = &[$(Self::$variant),+];

            /// The code's wire text.
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $code,)+
                }
            }

            /// The HTTP status a control plane route answers the code with; `None` for a code
            /// that rides only the daemon's JSON-RPC wire.
            pub const fn http_status(self) -> Option<u16> {
                match self {
                    $(Self::$variant => refusal_codes!(@status $($status)?),)+
                }
            }
        }
    };
    (@status) => { None };
    (@status $status:literal) => { Some($status) };
}

refusal_codes! {
    /// Requested definition name already exists, compared case-insensitively under full Unicode
    /// case folding.
    AgentDefinitionNameConflict = "agent.definition_name_conflict" (409);
    /// No definition with the given `definitionId` exists on this node.
    AgentDefinitionNotFound = "agent.definition_not_found" (404);
    /// The definition registry could not be read: the library's own list read renders this refusal
    /// in place of its rows rather than an empty library, and a run that names a saved agent
    /// refuses rather than starting one the registry could not describe.
    AgentDefinitionUnreadable = "agent.definition_unreadable" (503);
    /// `agent.definitionExport` could not write a definition's file into the chosen folder.
    AgentExportWriteFailed = "agent.export_write_failed" (500);
    /// Agent does not exist in the session (`data.fields`: `agentId`).
    AgentNotFound = "agent.not_found" (404);
    /// A provider-axis member on `agent.configUpdate` names something the machine cannot honor: an
    /// unregistered driver, a model absent from the target driver's `listModels`, an effort absent
    /// from that model's `effortLevels`, a larger window the target model's catalog does not offer
    /// at that figure, an output-speed value absent from the `outputSpeedLevels` published for the
    /// target model (its own list where its provider publishes one per model, else the driver's),
    /// or `ultracode: true` on a session whose Claude Code reports `ultracodeAvailable` false.
    AgentProviderAxisInvalid = "agent.provider_axis_invalid" (400);
    /// The definition exists but cannot currently produce a runnable agent.
    AgentResolutionRefused = "agent.resolution_refused" (409);
    /// `agent.definitionUpdate` refused the change.
    AgentUpdateRefused = "agent.update_refused" (409);
    /// Approval request has already been resolved.
    ApprovalAlreadyResolved = "approval.already_resolved" (409);
    /// `approval.denialOverride` names a `denialId` the daemon holds no block for.
    ApprovalDenialNotFound = "approval.denial_not_found" (404);
    /// `approval.denialOverride` names a block the provider's own reviewer marked not overridable
    /// (`overridable: false`), so no person can overrule it.
    ApprovalDenialNotOverridable = "approval.denial_not_overridable" (409);
    /// Approval request does not exist.
    ApprovalNotFound = "approval.not_found" (404);
    /// A permission check or approval mutation was rejected fail-closed because the daemon's
    /// approval-persistence layer is unavailable.
    ApprovalPersistenceUnavailable = "approval.persistence_unavailable" (503);
    /// Approval request was canceled and can no longer be resolved.
    ApprovalRequestCanceled = "approval.request_canceled" (409);
    /// `approval.resolve` sent an answer its request cannot take, and nothing was recorded.
    ApprovalResolutionInvalid = "approval.resolution_invalid" (422);
    /// Approval rule has already been revoked.
    ApprovalRuleAlreadyRevoked = "approval.rule_already_revoked" (409);
    /// Approval rule does not exist where the provider keeps it.
    ApprovalRuleNotFound = "approval.rule_not_found" (404);
    /// `approval.resolve` recorded the answer and the provider took it, so the call runs or is
    /// refused on it, but the provider could not keep the rule the answer asked for (it refused the
    /// settings update, or its rule file could not be written), so no rule was made and the
    /// resolution records no remembered scope.
    ApprovalRuleNotKept = "approval.rule_not_kept" (500);
    /// A client's `artifact.publish` declared `artifactType: "file"`.
    ArtifactFilePublishRefused = "artifact.file_publish_refused" (422);
    /// Artifact content hash does not match the expected value.
    ArtifactHashMismatch = "artifact.hash_mismatch" (409);
    /// `AttachmentIngestInit`, or a client's `artifact.publish` before its payload is decoded,
    /// refused because the open-upload count (ingest streams and client publishes in flight
    /// together) has reached `max_active_ingest_streams` or the spool's volume, read at admission,
    /// has no room for this declaration beside the open uploads' reservations.
    ArtifactIngestCapacityExhausted = "artifact.ingest_capacity_exhausted" (429);
    /// An ingest stream call that cannot proceed and cannot be retried in place, with
    /// `data.fields.reason` naming why: `sequence_broken` (a sequence gap, regression, or same-
    /// sequence different-bytes chunk, which terminates the live stream and deletes its spool),
    /// `lifetime_expired` (a call on a stream past `max_ingest_stream_lifetime`), `unknown_stream`
    /// (an `ingestId` the daemon does not hold, a terminated stream's among them),
    /// `already_completed` (a `Chunk` on a completed stream) or `completion_record_mismatch` (a
    /// retried `Complete` whose saved result no longer carries the digest it was committed under,
    /// which ends the stream rather than answer it).
    ArtifactIngestStreamInvalid = "artifact.ingest_stream_invalid" (409);
    /// Artifact does not exist.
    ArtifactNotFound = "artifact.not_found" (404);
    /// `data.fields.reason` names which bound it hit.
    ArtifactTooLarge = "artifact.too_large" (413);
    /// The type check on a payload's leading bytes could not run to an answer, at
    /// `AttachmentIngestComplete` or a client's `artifact.publish`: it ran past its time bound, its
    /// thread failed or ran out of its heap bound, too many payloads were already waiting for a
    /// thread, or the daemon was stopping.
    ArtifactTypeCheckUnavailable = "artifact.type_check_unavailable" (503);
    /// The type detector ran over a payload's leading bytes and refused them, at
    /// `AttachmentIngestComplete` or a client's `artifact.publish`.
    ArtifactTypeUnreadable = "artifact.type_unreadable" (422);
    /// `attention.deliveryTest` for a channel that is not set up.
    AttentionDeliveryNotConfigured = "attention.delivery_not_configured" (409);
    /// The keychain holding a channel's secret is locked or unavailable.
    AttentionDeliveryStoreUnavailable = "attention.delivery_store_unavailable" (503);
    /// `daemon.hello` with the right session token from a process the daemon itself started outside
    /// the person's terminals, such as a command an agent ran, from one a provider service the
    /// daemon holds a connection to started, or from one the system could not name or trace to its
    /// first process.
    AuthCallerRefused = "auth.caller_refused" ();
    /// DPoP proof does not match the bound token.
    AuthDpopMismatch = "auth.dpop_mismatch" (401);
    /// Token does not have the required scope for this operation.
    AuthInsufficientScope = "auth.insufficient_scope" (403);
    /// Authentication token has expired.
    AuthTokenExpired = "auth.token_expired" (401);
    /// Authentication token is malformed or invalid.
    AuthTokenInvalid = "auth.token_invalid" (401);
    /// The machine runs none of the channel profiles a device's first frame offered, so it closes
    /// the connection with this code.
    ChannelNoCommonProfile = "channel.no_common_profile" (426);
    /// Sending to the cloud refused because this session cannot use its provider's cloud.
    CloudUnavailable = "cloud.unavailable" (403);
    /// A branch-name pattern refused at save, from `daemon.machineSettingsUpdate` (`Every
    /// project`'s `Branch names`) or `repo.projectBranchPatternUpdate`, one rule for both.
    DaemonBranchPatternRefused = "daemon.branch_pattern_refused" (422);
    /// An environment row's name refused at save, from `daemon.machineSettingsUpdate` or
    /// `repo.projectEnvironmentUpdate`.
    DaemonEnvironmentNameRefused = "daemon.environment_name_refused" (422);
    /// The answer to a `daemon.hello` carrying the start's session token while the service repairs
    /// its database file, when it serves only the lifecycle verbs on that connection, so
    /// `daemon.stop` or `daemon.restart` ends the repair.
    DaemonRepairing = "daemon.repairing" (503);
    /// A mutating call refused by the whole service until the restart's recovery pass has listed
    /// the sessions it rebuilds, a call with no top-level `sessionId` until the pass ends, since it
    /// can reach any session through a project, a mount, a workspace or a tree, or any call while
    /// the local store is unavailable.
    DaemonWriteRefused = "daemon.write_refused" (503);
    /// Requested capability is not supported by the driver.
    DriverCapabilityUnsupported = "driver.capability_unsupported" (400);
    /// A session create asks for a larger window (`AgentProviderBinding.largerWindow`) that the
    /// catalog does not offer for that model at that figure.
    DriverLargerWindowUnavailable = "driver.larger_window_unavailable" (400);
    /// Provider driver operation timed out.
    DriverTimeout = "driver.timeout" (504);
    /// Provider driver is currently unavailable.
    DriverUnavailable = "driver.unavailable" (503);
    /// An `EventCursor` submitted to `readAfterCursor` / `readWindow` cannot be decoded to a log
    /// position.
    EventCursorUnresolvable = "event.cursor_unresolvable" (400);
    /// A Generate, `gitflow.commitMessageGenerate` or `gitflow.changeRequestTextGenerate`, failed.
    GitflowGenerateFailed = "gitflow.generate_failed" (502);
    /// A host the person tried to add was not added, and nothing is saved.
    GitflowHostInvalid = "gitflow.host_invalid" (422);
    /// A read the review pane depends on still failed after the daemon's one retry, so the pane
    /// shows its own error state and keeps what it already drew.
    GitflowReadFailed = "gitflow.read_failed" (500);
    /// A `highlight.read` that a newer read for the same block, on the same connection, replaced
    /// while it waited to be colored.
    HighlightReadReplaced = "highlight.read_replaced" (409);
    /// A `clientIdempotencyKey` was reused with a differing payload.
    InterventionIdempotencyConflict = "intervention.idempotency_conflict" (422);
    /// The request's params failed the method's contract check, so no handler ran, or the handler
    /// found they name nothing it can read.
    InvalidParams = "invalid_params" ();
    /// The handler's result failed the method's result check: a daemon fault, never the client's.
    InvalidResult = "invalid_result" ();
    /// The submitted server configuration failed validation.
    McpConfigInvalid = "mcp.config_invalid" (400);
    /// A Codex config write lost to a concurrent edit, on either arm: a `user`-scope write's
    /// `expected_version` hit `configVersionConflict`, which is returned at once with no retry, and
    /// the error carries both version tokens so the caller can re-inspect.
    McpConfigWriteConflict = "mcp.config_write_conflict" (409);
    /// The daemon failed to launch the sign-in.
    McpOauthFlowFailed = "mcp.oauth_flow_failed" (502);
    /// No server with the requested `(provider, scope, scopeRef, serverName)` binding exists in the
    /// unified inventory.
    McpServerNotFound = "mcp.server_not_found" (404);
    /// The request names a method the daemon does not register; no handler runs.
    MethodNotFound = "method_not_found" ();
    /// An address Preview will not open.
    PreviewAddressRefused = "preview.address_refused" (422);
    /// A device's paste, select all or cut for a menu that is no longer the page's current one.
    PreviewEditRefused = "preview.edit_refused" (409);
    /// A device's answer to a folder picker named a file's path that is empty, absolute, holds an
    /// empty, `.` or `..` segment, or is missing, or main's download report named a file by
    /// anything but an id main minted.
    PreviewFilePathRefused = "preview.file_path_refused" (422);
    /// `preview.portShareAdd` named a port already on the shared list.
    PreviewPortAlreadyShared = "preview.port_already_shared" (409);
    /// A forward or a `preview.portTicketIssue` named a port that is not on the shared list.
    PreviewPortNotShared = "preview.port_not_shared" (403);
    /// Second `daemon.hello` on a connection with latched outcome.
    ProtocolHandshakeAlreadyCompleted = "protocol.handshake_already_completed" ();
    /// Any method but `daemon.hello` dispatched in `pre` state.
    ProtocolHandshakeRequired = "protocol.handshake_required" ();
    /// Mutating dispatch attempted in `done-incompatible` state.
    ProtocolVersionMismatch = "protocol.version_mismatch" ();
    /// Nothing runnable sits at the command path the person typed.
    ProviderCommandNotRunnable = "provider.command_not_runnable" (422);
    /// The provider's command is not installed, so a setting that needs it cannot be turned on:
    /// availability for new sessions, the shared terminal service, and the terminal plugin.
    ProviderNotInstalled = "provider.not_installed" (409);
    /// `providerAccount.remove` refused because a run bound to the account is live.
    ProvideraccountAccountInUse = "provideraccount.account_in_use" (409);
    /// The account's credential home is missing, unreadable, or structurally unusable.
    ProvideraccountCredentialHomeUnavailable = "provideraccount.credential_home_unavailable" (503);
    /// The operating system's keychain would not take the token, so registration refuses and the
    /// token is stored nowhere else.
    ProvideraccountCredentialSealRefused = "provideraccount.credential_seal_refused" (503);
    /// A concurrent `providerAccount.setCurrent` lost the partial-unique-index race.
    ProvideraccountDefaultConflict = "provideraccount.default_conflict" (409);
    /// The name given to an account added from a pasted token or API key repeats one of that
    /// provider's other account names, trimmed and compared by full Unicode case folding
    /// (`foldName`).
    ProvideraccountDisplayLabelTaken = "provideraccount.display_label_taken" (409);
    /// Accounts exist for the provider but none carries the current mark, so resolution is
    /// ambiguous and refuses rather than picking one.
    ProvideraccountNoDefault = "provideraccount.no_default" (400);
    /// `providerAccount.setCurrent` named a known-dead target: its stored reading is
    /// `reauth_required`, or its last limits read showed its Claude Code login gone
    /// (`rate_limits_available: false` with `subscription_type: null`).
    ProvideraccountNotAuthenticated = "provideraccount.not_authenticated" (401);
    /// No account is registered for the requested provider.
    ProvideraccountNotRegistered = "provideraccount.not_registered" (400);
    /// The caller is neither this machine's own client nor a linked device: a session asked for a
    /// registry verb.
    ProvideraccountPermissionDenied = "provideraccount.permission_denied" (403);
    /// `providerAccount.update` carried `displayLabel` for an account that carries no typed name:
    /// only an account added from a pasted token or API key is named by the person, and every other
    /// account is named by the identity its provider reports.
    ProvideraccountRenameRefused = "provideraccount.rename_refused" (409);
    /// A brokered sign-in is already in flight for this account.
    ProvideraccountSigninInFlight = "provideraccount.signin_in_flight" (409);
    /// Brokered sign-in was requested for a provider whose pinned flow emits neither an
    /// authorization URL nor a device code, so there is nothing the person could act on.
    ProvideraccountSigninUnsupported = "provideraccount.signin_unsupported" (400);
    /// The registration-time status invocation, run on a pasted token, reported no signed-in mode,
    /// so the provider did not accept the token.
    ProvideraccountTokenNotAccepted = "provideraccount.token_not_accepted" (422);
    /// The referenced `providerAccountId` is not present in the registry (never registered, or
    /// removed after the reference was taken).
    ProvideraccountUnknown = "provideraccount.unknown" (404);
    /// The PTY a shell needs cannot be opened: `sidekicks-terminal` in the daemon could not create
    /// it (ConPTY on Windows, `alacritty_terminal`'s tty elsewhere).
    PtyBackendUnavailable = "pty.backend_unavailable" (503);
    /// `pty.open` on a chat session, which is bound to a managed workspace and no repository and
    /// has no shell.
    PtyChatUnsupported = "pty.chat_unsupported" (422);
    /// `session.takeControl`, a resize, a pane's appearance report or a close refused for the named
    /// shell because someone else holds it.
    PtyControlHeldByOther = "pty.control_held_by_other" (409);
    /// A write from a connection the shell's hold is not bound to.
    PtyControlNotHeld = "pty.control_not_held" (409);
    /// A request naming a shell its session does not have: no shell by that terminal id, or another
    /// session's shell, which the refusal never tells apart.
    PtyNotFound = "pty.not_found" (404);
    /// `session.takeControl` or `pty.write` naming an output subscription that is not the calling
    /// connection's own open `pty.outputSubscribe` subscription to the named shell: no such
    /// subscription, another connection's, or one to another shell, which the refusal never tells
    /// apart.
    PtyOutputSubscriptionNotFound = "pty.output_subscription_not_found" (404);
    /// A change to a waiting message refused: a removal (`run.queueCancel`) or an edit
    /// (`run.queueCreate` with `replacesQueueItemId`) of a message the agent has already taken, a
    /// removal or an edit of one Claude Code did not give back, its withdraw failing or passing the
    /// daemon's ten-second withdraw deadline, which then reads not delivered, or a
    /// `run.queueReorder` whose list is not exactly the waiting items.
    QueueChangeRefused = "queue.change_refused" (409);
    /// A change (`run.queueCancel`, an edit through `run.queueCreate` with `replacesQueueItemId`,
    /// or `run.queueReorder`) named a queue item the queue does not hold: an id it never stored, an
    /// item of another session, or one of another queue than the call names.
    QueueItemNotFound = "queue.item_not_found" (404);
    /// New queued run-control work was rejected fail-closed because the daemon's queue-persistence
    /// layer is unavailable.
    QueuePersistenceUnavailable = "queue.persistence_unavailable" (503);
    /// A send (`run.queueCreate`) whose session's lead run started, ended or was continued between
    /// each read of it and the write that sends into it, every time the daemon tried.
    QueueRunChanged = "queue.run_changed" (409);
    /// A sign-in route of the relay refused a request over its rate limit.
    RateLimited = "rate_limited" (429);
    /// Relay authentication failed.
    RelayAuthenticationFailed = "relay.authentication_failed" (401);
    /// Relay connection to the upstream service failed.
    RelayConnectionFailed = "relay.connection_failed" (502);
    /// A channel frame failed the Noise transport's decryption.
    RelayReplayRejected = "relay.replay_rejected" (409);
    /// A request reached a sign-in route (sign-in, token refresh or device linking) with no source
    /// address the relay can count, so it is refused before anything is counted rather than counted
    /// in a bucket other callers share.
    RelaySourceAddressUnresolvable = "relay.source_address_unresolvable" (400);
    /// The machine refused a pinned relay whose key changed.
    RelaySpkiMismatch = "relay.spki_mismatch" (412);
    /// The resolved canonical root is already attached on this machine: a mount belongs to the
    /// machine, one per canonical root.
    RepoAlreadyAttached = "repo.already_attached" (409);
    /// `repo.clone` refused before anything is fetched.
    RepoCloneRefused = "repo.clone_refused" (422);
    /// `repo.clone`, `repo.cloneFolderRead`, `repo.cloneSubscribe`, `repo.cloneAnswer`,
    /// `repo.cloneCancel` and `repo.largeFilesPull` answered while the clone service is not
    /// running.
    RepoCloneUnavailable = "repo.clone_unavailable" (503);
    /// Detach refused while an agent runs anywhere in the project, naming the running session
    /// (drawn `Busy: <session> is running in it.`).
    RepoDetachConflict = "repo.detach_conflict" (409);
    /// `repo.attach` refused because the background service cannot reach the folder.
    RepoFolderUnreachable = "repo.folder_unreachable" (422);
    /// The mount is a chat's managed workspace, which only that chat binds and only its purge
    /// removes: another session's bind, any detach and a `session.setWorkingFolder` of the chat are
    /// refused, writing nothing (`data.fields`: `repoMountId`).
    RepoMountManaged = "repo.mount_managed" (409);
    /// Repo mount does not exist, or is no longer attached for a bind or a project `session.create`
    /// to name.
    RepoNotFound = "repo.not_found" (404);
    /// A picked folder lies outside the project's admitted roots.
    RepoOutsideTrustEnvelope = "repo.outside_trust_envelope" (422);
    /// `repo.mountReattach` refused, writing nothing, while an agent runs anywhere in the project.
    RepoReattachConflict = "repo.reattach_conflict" (409);
    /// `repo.mountReattach` refused, writing nothing.
    RepoReattachRefused = "repo.reattach_refused" (422);
    /// Canonical repository root could not be resolved for the supplied path.
    RepoRootResolutionFailed = "repo.root_resolution_failed" (422);
    /// A call the client canceled with `$/cancelRequest` before the daemon reached its commit
    /// point.
    RequestCanceled = "request.canceled" ();
    /// A request would pass a daemon limit.
    ResourceLimitExceeded = "resource.limit_exceeded" (429);
    /// A control on one named child of a run.
    RunChildControlRefused = "run.child_control_refused" (409);
    /// Requested state transition is not allowed from the current run state.
    RunInvalidTransition = "run.invalid_transition" (409);
    /// Run does not exist.
    RunNotFound = "run.not_found" (404);
    /// Run recovery failed due to an internal error.
    RunRecoveryFailed = "run.recovery_failed" (500);
    /// A `run.pause` or `run.resume` whose `expectedRunVersion` is not the run's current version,
    /// older or newer.
    RunVersionStale = "run.version_stale" (409);
    /// Caller is not authorized for the machine the request names: the caller's verified principal
    /// does not own the machine the request's `nodeId` names (`runtime_nodes.user_id`).
    RuntimenodePermissionDenied = "runtimenode.permission_denied" (403);
    /// Session has already been closed and cannot be modified.
    SessionAlreadyClosed = "session.already_closed" (409);
    /// A file `session.attachmentAdd` did not stage.
    SessionAttachmentRefused = "session.attachment_refused" (422);
    /// A change the session's state does not take: a `provisioning` session is neither archived,
    /// closed nor converted, and a `purge_requested` one, being deleted, takes no change.
    SessionChangeRefused = "session.change_refused" (409);
    /// A conversion stopped after the repository was attached.
    SessionConvertIncomplete = "session.convert_incomplete" (500);
    /// `session.convert` named a session that is not a chat, a chat with no managed workspace to
    /// convert (`data.fields.reason: no_managed_workspace`), a `clientIdempotencyKey` another
    /// session's conversion holds (`reason: idempotency_key_reused`), or a folder other than the
    /// one a chat's stopped conversion copies into (`reason: conversion_unfinished`, with that
    /// conversion's `repoMountId`).
    SessionConvertRefused = "session.convert_refused" (409);
    /// `session.groupCreate` or `session.groupRename` named a group another group of the session's
    /// project already holds, ignoring case.
    SessionGroupNameTaken = "session.group_name_taken" (409);
    /// `session.groupCreate`, `session.groupMove` or `session.create`'s `groupId` asked to put a
    /// chat in a group, or a session in a group of another project.
    SessionGroupRefused = "session.group_refused" (422);
    /// `session.linkRemove` named a link the daemon wrote from an event (`started`, `copied_from`,
    /// `messaged`, `asked`, `mentioned`), which records what happened.
    SessionLinkNotRemovable = "session.link_not_removable" (409);
    /// Session does not exist.
    SessionNotFound = "session.not_found" (404);
    /// A permission level the session's provider, its account or its model cannot run, sent on
    /// `session.permissionLevelUpdate` or as `plan.resolve`'s `fresh.level`.
    SessionPermissionLevelUnavailable = "session.permission_level_unavailable" (400);
    /// `session.recoveryContinue` or `session.recoveryDelete` named a session the refusal does not
    /// fit.
    SessionRecoveryRefused = "session.recovery_refused" (409);
    /// Raised by `session.reviewNoteUpdate` and `session.reviewNoteAdd`.
    SessionReviewNoteNotFound = "session.review_note_not_found" (404);
    /// A `session.search` `afterCursor` the daemon did not write, one written for another query, or
    /// one whose search the daemon no longer holds.
    SessionSearchCursorUnresolvable = "session.search_cursor_unresolvable" (400);
    /// A `session.fileSearch` whose session has no working folder in place, yet or any more,
    /// nothing being listed, or a `session.setWorkingFolder` whose session works in no folder any
    /// more, nothing being moved.
    SessionWorkingFolderUnavailable = "session.working_folder_unavailable" (409);
    /// A write to a session whose history is damaged, or that the restart's recovery pass is still
    /// rebuilding, at the wire for a call naming the session and at the append for any of its
    /// events but the pass's own.
    SessionWriteRefused = "session.write_refused" (409);
    /// A save would rename a folder of ours onto a name another folder of ours already holds in the
    /// same place.
    SkillNameTaken = "skill.name_taken" (409);
    /// `skill.update` refused a path in the folder it would save, or `run.queueCreate` refused a
    /// picked skill whose name and folder match no row of `skill.list`, or, for a Codex agent, no
    /// skill Codex's own list names in that folder.
    SkillPathRefused = "skill.path_refused" (422);
    /// A write to a skill was refused.
    SkillWriteRefused = "skill.write_refused" (409);
    /// Unexpected internal error.
    SystemInternalError = "system.internal_error" (500);
    /// System is undergoing maintenance.
    SystemMaintenance = "system.maintenance" (503);
    /// Per-request envelope-level `protocolVersion` field violates, the wrong JSON type, or fails
    /// the ISO 8601 `YYYY-MM-DD` shape.
    TransportInvalidProtocolVersion = "transport.invalid_protocol_version" (400);
    /// An inbound message passed the 4 MiB cap on its JSON or its attachments.
    TransportMessageTooLarge = "transport.message_too_large" (413);
    /// A subscribe call found its connection already holding 10,000 open subscriptions; it may
    /// be sent again once one closes.
    TransportSubscriptionLimitReached = "transport.subscription_limit_reached" (429);
    /// The client cannot reach the daemon's OS-local socket or named pipe, or its link to the
    /// daemon is down.
    TransportUnavailable = "transport.unavailable" (503);
    /// Bootstrap rejected an unrecognized SecureDefaults config key.
    UnknownSetting = "unknown_setting" ();
    /// The WebAuthn ceremony challenge presented at verification is unknown, already consumed, or
    /// expired.
    UserWebauthnChallengeInvalid = "user.webauthn_challenge_invalid" (400);
    /// A WebAuthn registration or assertion response failed verification.
    UserWebauthnVerificationFailed = "user.webauthn_verification_failed" (400);
    /// Client above daemon's lex-max supported version.
    VersionCeilingExceeded = "version.ceiling_exceeded" ();
    /// Client below daemon's lex-min supported version.
    VersionFloorExceeded = "version.floor_exceeded" ();
    /// Codex could not start the call `voice.callStart` asked for.
    VoiceCallStartFailed = "voice.call_start_failed" (502);
    /// Voice refused on an account its provider gives no voice: on Claude Code, an account that is
    /// neither a Claude sign-in nor a pasted Claude token.
    VoiceUnavailable = "voice.unavailable" (403);
    /// A full-tier Code step whose package install did not finish.
    WorkflowCodeInstallFailed = "workflow.code_install_failed" (500);
    /// A Code step over its memory budget, 256 MiB per node by default and settable.
    WorkflowCodeOverBudget = "workflow.code_over_budget" (422);
    /// A start of a workflow version whose Code steps' packages are not locked.
    WorkflowCodePackagesNotLocked = "workflow.code_packages_not_locked" (409);
    /// A saved or imported document the daemon's own re-check refuses.
    WorkflowDefinitionRefused = "workflow.definition_refused" (422);
    /// An import whose schema version is unknown.
    WorkflowImportSchemaUnknown = "workflow.import_schema_unknown" (422);
    /// A start that leaves a required input its workflow declares unfilled, or gives an input a
    /// value that does not fit it.
    WorkflowInputRequired = "workflow.input_required" (422);
    /// A run or step move its status does not allow: retrying from a step that did not fail,
    /// posting the results of an unfinished run, or opening a fix session on a step that did not
    /// fail.
    WorkflowInvalidTransition = "workflow.invalid_transition" (409);
    /// A workflow definition or run that does not exist.
    WorkflowNotFound = "workflow.not_found" (404);
    /// A `workflow.runStart` from a project session that names a project: that session's run works
    /// in the session's own repository, so nothing runs.
    WorkflowProjectOnProjectSession = "workflow.project_on_project_session" (422);
    /// Frozen-definition re-pin refused: a step of the run is still in flight.
    WorkflowRepairAttemptInFlight = "workflow.repair_attempt_in_flight" (409);
    /// Frozen-definition re-pin refused: the target run is not parked.
    WorkflowRepairNotParked = "workflow.repair_not_parked" (409);
    /// Frozen-definition re-pin refused: the target version cannot account for the nodes the run
    /// has already completed.
    WorkflowRepairVersionUnaccountable = "workflow.repair_version_unaccountable" (409);
    /// A start, or a node run (`workflow.nodeExecute`), that names no project's repository.
    WorkflowRepositoryRequired = "workflow.repository_required" (422);
    /// `workflow.runResume` refused because the target run is not parked.
    WorkflowResumeNotParked = "workflow.resume_not_parked" (409);
    /// `Retry from this step` refused while the source run is still going.
    WorkflowRetryUnavailable = "workflow.retry_unavailable" (409);
    /// A form draft save or a form submit carrying a revision that is no longer current.
    WorkflowRevisionStale = "workflow.revision_stale" (409);
    /// `workflow.runCancel` refused because the run has ended, so there is nothing to cancel and
    /// reporting success would misinform the person about what their action did.
    WorkflowRunNotCancelable = "workflow.run_not_cancelable" (409);
    /// `Delete run` on a run that is `new`, `running` or `waiting` or is a failed run parked on its
    /// failed step, or on a chain's first run while a later run of its chain is one of those, drawn
    /// `Cancel it first.`.
    WorkflowRunNotDeletable = "workflow.run_not_deletable" (409);
    /// A full-tier Code step, or a shell step at the Sandboxed level, whose provider sandbox did
    /// not start.
    WorkflowSandboxUnavailable = "workflow.sandbox_unavailable" (503);
    /// A secret name refused at save.
    WorkflowSecretNameInvalid = "workflow.secret_name_invalid" (422);
    /// A secret reference the keychain does not hold.
    WorkflowSecretNotFound = "workflow.secret_not_found" (404);
    /// The keychain is locked or unavailable.
    WorkflowSecretStoreUnavailable = "workflow.secret_store_unavailable" (503);
    /// Workflow run start refused by Cedar under `Action::"workflow::start"`, or whose principal
    /// could not be resolved: an agent's start, or a run a trigger fires, judged when it fires with
    /// the person recorded as its starter.
    WorkflowStartDenied = "workflow.start_denied" (403);
    /// A form submitted, an approval answered or a form read on a step that is no longer waiting.
    WorkflowStepNotWaiting = "workflow.step_not_waiting" (409);
    /// A quick step's engine that did not start in time.
    WorkflowStepThreadFailed = "workflow.step_thread_failed" (500);
    /// A step or a run cut by a time limit, read `failed · timed out`.
    WorkflowStepTimedOut = "workflow.step_timed_out" (504);
    /// A trigger that cannot be armed.
    WorkflowTriggerUnarmable = "workflow.trigger_unarmable" (422);
    /// A save against a stale definition version.
    WorkflowVersionStale = "workflow.version_stale" (409);
    /// A webhook call with the wrong token, or any call while no token exists.
    WorkflowWebhookTokenMismatch = "workflow.webhook_token_mismatch" (403);
    /// A wire-initiated (pre-run) `repo.executionRootPrepare` for a `provisioned-worktree` omitted
    /// `branchName`: the slug rule's derivation inputs (queue-item summary / run id) exist only on
    /// the run-setup gate path, so wire prepares must carry the branch.
    WorkspaceBranchNameRequired = "workspace.branch_name_required" (400);
    /// A repo-bound run reached the setup gate with no resolved execution root for the workspace's
    /// selected mode and root preparation failed.
    WorkspaceExecutionRootUnresolved = "workspace.execution_root_unresolved" (409);
    /// A worktree was requested for a chat's managed workspace, which offers only its own root.
    WorkspaceModeUnsupported = "workspace.mode_unsupported" (400);
    /// Workspace does not exist.
    WorkspaceNotFound = "workspace.not_found" (404);
    /// Preparing the workspace failed due to an internal error.
    WorkspacePreparationFailed = "workspace.preparation_failed" (500);
    /// Workspace execution root is unavailable.
    WorkspaceStale = "workspace.stale" (409);
    /// Caller-supplied branch name collides with a live checkout on the same mount.
    WorktreeBranchCollision = "worktree.branch_collision" (409);
    /// Worktree creation failed (git error, filesystem error, or dynamic worktree unavailability at
    /// preparation time).
    WorktreeCreateFailed = "worktree.create_failed" (500);
    /// Worktree does not exist.
    WorktreeNotFound = "worktree.not_found" (404);
    /// `repo.worktreeRestore` or `repo.removedWorktreeDelete` named a kept worktree that does not
    /// exist, such as one a put-back or deletion queued before it already removed.
    WorktreeRemovedNotFound = "worktree.removed_not_found" (404);
    /// `repo.worktreeRetire` with `discard: false` refused.
    WorktreeRetireConflict = "worktree.retire_conflict" (409);
    /// `repo.worktreeRetire` with `discard: true` refused because the operating system refused the
    /// move-aside rename while a program outside the app holds a file in the worktree open.
    WorktreeRetireFolderHeld = "worktree.retire_folder_held" (409);
    /// `repo.worktreeRetire` with `discard: true` refused because the move across volumes copied
    /// the tree whole to its kept place but could not remove the original completely.
    WorktreeRetireIncomplete = "worktree.retire_incomplete" (409);
}

/// The TypeScript module that owns the refusal union.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: RefusalCode::TYPESCRIPT_MODULE_PATH,
    doc: "Every refusal code a daemon method or a control plane route answers with.",
    definitions: &[],
    constants: &[],
    method_tables: &[],
};
