//! The refusal codes: every `data.type` a refusal carries, each with its category, the
//! `data.category` a client acts on when it does not know the code, and the HTTP status a control
//! plane route answers it with. TypeScript gets the codes as one string union.

use serde::{Deserialize, Serialize};

use crate::jsonrpc::error_code::JsonRpcErrorCode;
use crate::jsonrpc::refusal::category::{KnownRefusalCategory, RefusalCategory};
use crate::typescript::{Definition, TypeScriptModule};

pub mod category;

/// Declares [`RefusalCode`] from one line per code: its variant, its wire text and, in
/// parentheses, its category and its HTTP status, no status for a code that rides only the
/// daemon's JSON-RPC wire, then after a `;` the JSON-RPC number of a protocol outcome, none for a
/// domain refusal.
macro_rules! refusal_codes {
    (
        $(
            $(#[doc = $doc:literal])+
            $variant:ident = $code:literal
                ($category:ident $(, $status:literal)? $(; $protocol:ident)?);
        )+
    ) => {
        $(
            const _: () = assert!(
                crate::wire::name::is_wire_name($code),
                concat!("not a wire name: ", $code),
            );
        )+

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

            /// The code's category, sent as `data.category`.
            pub const fn category(self) -> RefusalCategory {
                RefusalCategory::Known(self.known_category())
            }

            /// The code's category, as this build knows every one it makes.
            pub const fn known_category(self) -> KnownRefusalCategory {
                match self {
                    $(Self::$variant => KnownRefusalCategory::$category,)+
                }
            }

            /// The JSON-RPC number the code answers with: `-31000` for a domain refusal, JSON-RPC's
            /// own number for a protocol outcome.
            pub const fn json_rpc_code(self) -> JsonRpcErrorCode {
                match self {
                    $(Self::$variant => refusal_codes!(@protocol $($protocol)?),)+
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
    (@protocol) => { JsonRpcErrorCode::DomainRefusal };
    (@protocol $protocol:ident) => { JsonRpcErrorCode::$protocol };
    (@status) => { None };
    (@status $status:literal) => { Some($status) };
}

refusal_codes! {
    /// `account.signIn` on a machine already signed in to the hosted account; nothing starts.
    AccountAlreadySignedIn = "account.alreadySignedIn" (FailedPrecondition, 409);
    /// The `WebAuthn` ceremony challenge presented at verification is unknown, already consumed, or
    /// expired.
    AccountPasskeyChallengeInvalid = "account.passkey.challengeInvalid" (InvalidArgument, 400);
    /// A `WebAuthn` registration or assertion response failed verification.
    AccountPasskeyVerificationFailed = "account.passkey.verificationFailed" (InvalidArgument, 400);
    /// The `relayAddress` given to `account.signIn` is not a relay address; nothing is set and no
    /// sign-in starts.
    AccountRelayAddressInvalid = "account.relay.addressInvalid" (InvalidArgument, 422);
    /// `account.signIn` on a machine with no relay address set and none given in the request.
    AccountRelayNotConfigured = "account.relay.notConfigured" (FailedPrecondition, 409);
    /// A control on one named child of a run was refused: the child has ended or its provider
    /// declined.
    AgentChildRunControlRefused = "agent.childRun.controlRefused" (FailedPrecondition, 409);
    /// A child control or queue verb named a child handle that names no child of the run.
    AgentChildRunNotFound = "agent.childRun.notFound" (NotFound, 404);
    /// `agent.command.background` named a command that is not waiting in the foreground.
    AgentCommandNotInForeground = "agent.command.notInForeground" (FailedPrecondition, 409);
    /// `agent.command.stop` reached the provider, which answered that the command still runs.
    AgentCommandNotStopped = "agent.command.notStopped" (FailedPrecondition, 409);
    /// `agent.command.write` named a command that takes no input and has no prompt open.
    AgentCommandTakesNoInput = "agent.command.takesNoInput" (FailedPrecondition, 409);
    /// `agent.definition.export` could not write a definition's file into the chosen folder.
    AgentDefinitionExportWriteFailed = "agent.definition.exportWriteFailed" (Internal, 500);
    /// Requested definition name already exists, compared case-insensitively under full Unicode
    /// case folding.
    AgentDefinitionNameConflict = "agent.definition.nameConflict" (AlreadyExists, 409);
    /// No definition with the given `definitionId` exists on this machine.
    AgentDefinitionNotFound = "agent.definition.notFound" (NotFound, 404);
    /// The definition exists but cannot currently produce a runnable agent.
    AgentDefinitionResolutionRefused = "agent.definition.resolutionRefused"
        (FailedPrecondition, 409);
    /// The definition registry could not be read: the library's own list read renders this refusal
    /// in place of its rows rather than an empty library, and a run that names a saved agent
    /// refuses rather than starting one the registry could not describe.
    AgentDefinitionUnreadable = "agent.definition.unreadable" (Unavailable, 503);
    /// `agent.definition.update` refused the change.
    AgentDefinitionUpdateRefused = "agent.definition.updateRefused" (FailedPrecondition, 409);
    /// A `clientIdempotencyKey` was reused with a differing payload.
    AgentInterventionIdempotencyConflict = "agent.intervention.idempotencyConflict"
        (InvalidArgument, 422);
    /// Agent does not exist in the session (`data.fields`: `agentId`).
    AgentNotFound = "agent.notFound" (NotFound, 404);
    /// A provider-axis member on `agent.config.update` or `session.create` names something the
    /// machine cannot honor: an unregistered driver, a model absent from the target driver's
    /// `provider.model.list`, an effort absent from that model's `effortLevels`, a larger window
    /// (the `largerWindow` axis) the target model's catalog does not offer at that figure, an
    /// output-speed value absent from the `outputSpeedLevels` published for the
    /// target model (its own list where its provider publishes one per model, else the driver's),
    /// a session option the target driver does not declare, or a session option's value outside
    /// the target driver's declaration of it or one the provider reports this session cannot run.
    AgentProviderAxisInvalid = "agent.providerAxisInvalid" (InvalidArgument, 422);
    /// A change to a waiting message refused: a removal (`agent.queueItem.cancel`) or an edit
    /// (`agent.queueItem.create` with `replacesQueueItemId`) of a message the agent has already
    /// taken, a removal or an edit of one the provider did not give back, its withdraw failing or
    /// passing the daemon's ten-second withdraw deadline, which then reads not delivered, or an
    /// `agent.queueItem.reorder` whose list is not exactly the waiting items.
    AgentQueueItemChangeRefused = "agent.queueItem.changeRefused" (FailedPrecondition, 409);
    /// A change (`agent.queueItem.cancel`, an edit through `agent.queueItem.create` with
    /// `replacesQueueItemId`, or `agent.queueItem.reorder`) named a queue item the queue does not
    /// hold: an id it never stored, an item of another session, or one of another queue than the
    /// call names.
    AgentQueueItemNotFound = "agent.queueItem.notFound" (NotFound, 404);
    /// New queued run-control work was rejected fail-closed because the daemon's queue-persistence
    /// layer is unavailable.
    AgentQueueItemPersistenceUnavailable = "agent.queueItem.persistenceUnavailable"
        (Unavailable, 503);
    /// A send (`agent.queueItem.create`) whose session's lead run started, ended or was continued
    /// between each read of it and the write that sends into it, every time the daemon tried.
    AgentQueueItemRunChanged = "agent.queueItem.runChanged" (Aborted, 409);
    /// Requested state transition is not allowed from the current run state.
    AgentRunInvalidTransition = "agent.run.invalidTransition" (FailedPrecondition, 409);
    /// A read of a child run's rows named a run that has no parent.
    AgentRunNotChild = "agent.run.notChild" (FailedPrecondition, 409);
    /// Run does not exist.
    AgentRunNotFound = "agent.run.notFound" (NotFound, 404);
    /// Run recovery failed due to an internal error.
    AgentRunRecoveryFailed = "agent.run.recoveryFailed" (Internal, 500);
    /// An `agent.run.pause` or `agent.run.resume` whose `expectedRunVersion` is not the run's
    /// current version, older or newer.
    AgentRunVersionStale = "agent.run.versionStale" (Aborted, 409);
    /// Approval request has already been resolved.
    ApprovalAlreadyResolved = "approval.alreadyResolved" (FailedPrecondition, 409);
    /// `approval.denial.override` names a `denialId` the daemon holds no block for.
    ApprovalDenialNotFound = "approval.denial.notFound" (NotFound, 404);
    /// `approval.denial.override` names a block the provider's own reviewer marked not overridable
    /// (`overridable: false`), so no person can overrule it.
    ApprovalDenialNotOverridable = "approval.denial.notOverridable" (FailedPrecondition, 409);
    /// Approval request does not exist.
    ApprovalNotFound = "approval.notFound" (NotFound, 404);
    /// A permission check or approval mutation was rejected fail-closed because the daemon's
    /// approval-persistence layer is unavailable.
    ApprovalPersistenceUnavailable = "approval.persistenceUnavailable" (Unavailable, 503);
    /// Approval request was canceled and can no longer be resolved.
    ApprovalRequestCanceled = "approval.requestCanceled" (FailedPrecondition, 409);
    /// `approval.resolve` sent an answer its request cannot take, and nothing was recorded.
    ApprovalResolutionInvalid = "approval.resolutionInvalid" (InvalidArgument, 422);
    /// Approval rule has already been revoked.
    ApprovalRuleAlreadyRevoked = "approval.rule.alreadyRevoked" (FailedPrecondition, 409);
    /// Approval rule does not exist where the provider keeps it.
    ApprovalRuleNotFound = "approval.rule.notFound" (NotFound, 404);
    /// `approval.resolve` recorded the answer and the provider took it, but the provider could not
    /// keep the rule the answer asked for, so the resolution records no remembered scope; or
    /// `approval.rule.revoke` or `mcp.server.delete` could not take a rule out of a project's rule
    /// file (one the daemon does not edit, or one it could not write), so the rule still applies.
    ApprovalRuleNotKept = "approval.rule.notKept" (Internal, 500);
    /// A client's `artifact.publish` declared `artifactType: "file"`.
    ArtifactFilePublishRefused = "artifact.filePublishRefused" (InvalidArgument, 422);
    /// An `artifact.publish` or `artifact.ingest.start` reused a `clientIdempotencyKey` with a
    /// differing request; what the key first answered is untouched (`data.fields`: `artifactId`
    /// of a publish's first manifest, or `ingestId` of an opening's first stream).
    ArtifactIdempotencyConflict = "artifact.idempotencyConflict" (InvalidArgument, 422);
    /// `artifact.ingest.start`, or a client's `artifact.publish` once its frame is read, refused
    /// because the open-upload count (ingest streams and client publishes in flight together) has
    /// reached `max_active_ingest_streams` or the spool's volume, read at admission, has no room
    /// for this declaration beside the open uploads' reservations.
    ArtifactIngestCapacityExhausted = "artifact.ingest.capacityExhausted" (ResourceExhausted, 429);
    /// An ingest stream call that cannot proceed and cannot be retried in place, with
    /// `data.fields.reason` naming why: `sequenceBroken` (a sequence gap, regression, or same-
    /// sequence different-bytes chunk, which terminates the live stream and deletes its spool),
    /// `lifetimeExpired` (a call on a stream past `max_ingest_stream_lifetime`), `unknownStream`
    /// (an `ingestId` the daemon does not hold, a terminated stream's among them),
    /// `alreadyCompleted` (an `artifact.ingest.write` on a completed stream) or
    /// `completionRecordMismatch` (a retried `artifact.ingest.complete` whose saved result no
    /// longer carries the digest it was committed under, which ends the stream rather than answer
    /// it).
    ArtifactIngestStreamInvalid = "artifact.ingest.streamInvalid" (Aborted, 409);
    /// Artifact does not exist.
    ArtifactNotFound = "artifact.notFound" (NotFound, 404);
    /// `data.fields.reason` names which bound it hit.
    ArtifactTooLarge = "artifact.tooLarge" (ResourceExhausted, 413);
    /// `attention.delivery.test` for a channel that is not set up.
    AttentionDeliveryNotConfigured = "attention.delivery.notConfigured" (FailedPrecondition, 409);
    /// The keychain holding a channel's secret is locked or unavailable.
    AttentionDeliveryStoreUnavailable = "attention.delivery.storeUnavailable" (Unavailable, 503);
    /// `connection.initialize` with the right session token from a process the daemon itself
    /// started outside the person's terminals, such as a command an agent ran, from one a provider
    /// service the daemon holds a connection to started, or from one the system could not name or
    /// trace to its first process.
    AuthCallerRefused = "auth.callerRefused" (PermissionDenied);
    /// `DPoP` proof does not match the bound token.
    AuthDpopMismatch = "auth.dpopMismatch" (Unauthenticated, 401);
    /// Token does not have the required scope for this operation.
    AuthInsufficientScope = "auth.insufficientScope" (PermissionDenied, 403);
    /// Authentication token has expired.
    AuthTokenExpired = "auth.token.expired" (Unauthenticated, 401);
    /// Authentication token is malformed or invalid.
    AuthTokenInvalid = "auth.token.invalid" (Unauthenticated, 401);
    /// A channel frame failed the Noise transport's decryption (replayed, reordered, altered or
    /// forged, which no receiver can tell apart), on either carrier; the channel closes and the
    /// next connection runs a fresh handshake.
    ChannelDecryptionFailed = "channel.decryptionFailed" (Aborted);
    /// The machine runs none of the channel profiles the device offered, on either carrier, so it
    /// closes the connection with this code.
    ChannelNoCommonProfile = "channel.noCommonProfile" (Unimplemented);
    /// Sending to the cloud refused because the account's sign-in kind or plan lacks cloud tasks,
    /// with `data.fields.reason` `signInKindNotEntitled` or `subscriptionRequired`.
    CloudAccountNotEntitled = "cloud.accountNotEntitled" (PermissionDenied, 403);
    /// Sending to the cloud refused because the project has no GitHub remote.
    CloudGithubRemoteRequired = "cloud.githubRemoteRequired" (FailedPrecondition, 409);
    /// A call past the connection's calls in flight, refused at once.
    ConnectionCallLimitReached = "connection.call.limitReached" (ResourceExhausted);
    /// Second `connection.initialize` on a connection with latched outcome.
    ConnectionHandshakeAlreadyCompleted = "connection.handshake.alreadyCompleted"
        (FailedPrecondition);
    /// Any method but `connection.initialize` called before the handshake.
    ConnectionHandshakeRequired = "connection.handshake.required" (FailedPrecondition);
    /// An inbound message passed the 7 MiB cap on its JSON or the 4 MiB cap on its attachments.
    ConnectionMessageTooLarge = "connection.message.tooLarge"
        (ResourceExhausted, 413; InvalidRequest);
    /// A subscribe call found its connection already holding 10,000 open subscriptions; it may
    /// be sent again once one closes.
    ConnectionSubscriptionLimitReached = "connection.subscription.limitReached"
        (ResourceExhausted, 429);
    /// The client cannot reach the daemon's OS-local socket or named pipe, or its link to the
    /// daemon is down.
    ConnectionUnavailable = "connection.unavailable" (Unavailable, 503);
    /// The client's version is above the daemon's highest supported version.
    ConnectionVersionCeilingExceeded = "connection.version.ceilingExceeded" (FailedPrecondition);
    /// The client's version is below the daemon's lowest supported version.
    ConnectionVersionFloorExceeded = "connection.version.floorExceeded" (FailedPrecondition);
    /// A mutating call on a connection whose handshake settled as incompatible.
    ConnectionVersionMismatch = "connection.version.mismatch" (FailedPrecondition);
    /// `daemon.data.erase` refused before its answer, so nothing was erased: the keychain the erase
    /// must empty is locked or cannot be used. `data.fields.cause` is `locked` (drawn `Unlock the
    /// keychain, then try again.`) or `unavailable` (drawn `The keychain cannot be used right now.
    /// Nothing was erased.`).
    DaemonDataStoreUnavailable = "daemon.data.storeUnavailable" (Unavailable, 503);
    /// `daemon.data.erase` while an erase runs; nothing new starts, since the running one erases
    /// everything.
    DaemonDataEraseRunning = "daemon.data.eraseRunning" (FailedPrecondition, 409);
    /// `daemon.dataExport.start` while another export runs; `data.fields.jobId` names the running
    /// one, whose progress the caller can follow instead.
    DaemonDataExportAlreadyRunning = "daemon.dataExport.alreadyRunning" (FailedPrecondition, 409);
    /// `daemon.dataExport.start` named a folder that already exists; an export writes only into a
    /// new folder.
    DaemonDataExportDestinationAlreadyExists = "daemon.dataExport.destination.alreadyExists"
        (AlreadyExists, 409);
    /// `daemon.dataExport.start` named a folder that cannot be made: its parent is missing or not
    /// writable. `data.fields.path` names the folder.
    DaemonDataExportDestinationNotWritable = "daemon.dataExport.destination.notWritable"
        (PermissionDenied, 403);
    /// `daemon.dataExport.subscribe` or `daemon.dataExport.cancel` named a job this service does
    /// not know: never started, or started before the service last restarted.
    DaemonDataExportNotFound = "daemon.dataExport.notFound" (NotFound, 404);
    /// A request would pass a daemon limit.
    DaemonLimitExceeded = "daemon.limitExceeded" (ResourceExhausted, 429);
    /// The answer to a `connection.initialize` carrying the start's session token while the service
    /// repairs its database file, when it serves only the lifecycle verbs on that connection, so
    /// `daemon.stop` or `daemon.restart` ends the repair.
    DaemonRepairing = "daemon.repairing" (Unavailable, 503);
    /// A mutating call refused by the whole service until the restart's recovery pass has listed
    /// the sessions it rebuilds, a call with no top-level `sessionId` until the pass ends, since it
    /// can reach any session through a project, a mount, a workspace or a tree, or any call while
    /// the local store is unavailable.
    DaemonWriteRefused = "daemon.writeRefused" (Unavailable, 503);
    /// A Generate, `git.commitMessage.generate` or `git.changeRequest.text.generate`, failed
    /// upstream for a passing cause (overloaded, rate-limited, a server error, a dropped stream,
    /// retries spent, the picked model gone, no valid structured output), in the provider's own
    /// words; send it again.
    GitGenerateFailed = "git.generateFailed" (Unavailable, 503);
    /// A Generate the provider refused by its own policy (`data.fields.reason` `providerRefused`,
    /// with the provider's own words); a diff larger than the model's window is read in passes and
    /// never refused.
    GitGenerateRefused = "git.generateRefused" (FailedPrecondition, 409);
    /// A host the person tried to add was not added, and nothing is saved.
    GitHostInvalid = "git.host.invalid" (InvalidArgument, 422);
    /// A read the review pane depends on still failed after the daemon's one retry, so the pane
    /// shows its own error state and keeps what it already drew.
    GitReadFailed = "git.readFailed" (Internal, 500);
    /// A `highlight.read` that a newer read for the same block, on the same connection, replaced
    /// while it waited to be colored.
    HighlightReadReplaced = "highlight.readReplaced" (Canceled, 409);
    /// `machine.folder.list` asked for the top level (`{top: true}`) on macOS or Linux, which has
    /// none: only a Windows computer lists drives and distributions above its folders.
    MachineFolderTopLevelNotOffered = "machine.folder.topLevel.notOffered" (InvalidArgument, 422);
    /// `machine.register` named a machine id this account holds under another identity key: the
    /// machine's database was restored from before its registration, and only linking it again
    /// gives it a key the account trusts.
    MachineKeyChanged = "machine.keyChanged" (AlreadyExists, 409);
    /// Caller is not authorized for the machine the request names: the caller's verified principal
    /// does not own the machine the request's `machineId` names, by the account the machine is
    /// registered to.
    MachinePermissionDenied = "machine.permissionDenied" (PermissionDenied, 403);
    /// The MCP binding store cannot be read, so every MCP change fails closed until it can.
    McpBindingStoreUnavailable = "mcp.bindingStoreUnavailable" (Unavailable, 503);
    /// The submitted server configuration failed validation.
    McpServerConfigInvalid = "mcp.server.configInvalid" (InvalidArgument, 400);
    /// A write to a provider's own configuration lost to a concurrent edit, on either arm: a
    /// `user`-scope write's expected version was refused as stale, returned at once with no retry
    /// and carrying both version tokens so the caller can re-inspect, or the `project` file no
    /// longer hashes to what the daemon last read, so the edit is not written (`data.fields`:
    /// `provider`, `scope`, `serverName`, `reason` `staleVersion` or `projectFileChanged`, and on
    /// `staleVersion` `expectedVersion` and `currentVersion`).
    McpServerConfigWriteConflict = "mcp.server.configWriteConflict" (Aborted, 409);
    /// No server with the requested `(provider, scope, scopeRef, serverName)` binding exists in the
    /// unified inventory.
    McpServerNotFound = "mcp.server.notFound" (NotFound, 404);
    /// The server is off or not working, so it cannot answer a read of its resources.
    McpServerNotRunning = "mcp.server.notRunning" (FailedPrecondition, 409);
    /// The server or network was unreachable during discovery or registration, or the provider's
    /// flow failed to start for a passing cause; retry under a new key.
    McpServerSignInFailed = "mcp.server.signInFailed" (Unavailable, 503);
    /// The server publishes no sign-in route: no protected-resource or authorization-server
    /// metadata, or metadata the daemon cannot read.
    McpServerSignInUnsupported = "mcp.server.signInUnsupported" (Unimplemented, 422);
    /// `plan.resolve` named a plan the daemon does not hold.
    PlanNotFound = "plan.notFound" (NotFound, 404);
    /// An address Preview will not open.
    PreviewAddressRefused = "preview.addressRefused" (InvalidArgument, 422);
    /// A device's paste, select all or cut for a menu that is no longer the page's current one.
    PreviewEditRefused = "preview.editRefused" (Aborted, 409);
    /// A device's answer to a folder picker named a file's path that is empty, absolute, holds an
    /// empty, `.` or `..` segment, or is missing, or main's download report named a file by
    /// anything but an id main minted.
    PreviewFilePathRefused = "preview.filePathRefused" (InvalidArgument, 422);
    /// A forward or a `preview.portTicket.issue` named a port that is not on the shared list.
    PreviewPortNotShared = "preview.port.notShared" (PermissionDenied, 403);
    /// `preview.portShare.add` named a port already on the shared list.
    PreviewPortShareAlreadyExists = "preview.portShare.alreadyExists" (AlreadyExists, 409);
    /// A branch-name pattern refused at save, from `machine.settings.update` (`Every
    /// project`'s `Branch names`) or `project.branchPattern.update`, one rule for both.
    ProjectBranchPatternRefused = "project.branchPattern.refused" (InvalidArgument, 422);
    /// `project.clone.start` reused a `clientIdempotencyKey` with a differing request; the first
    /// clone is untouched (`data.fields`: `projectId` of the project the key first answered).
    ProjectCloneIdempotencyConflict = "project.clone.idempotencyConflict" (InvalidArgument, 422);
    /// `project.clone.start` refused before anything is fetched.
    ProjectCloneRefused = "project.clone.refused" (InvalidArgument, 422);
    /// `project.clone.start`, `project.clone.folder.read`, `project.clone.subscribe`,
    /// `project.clone.answer`, `project.clone.cancel` and `project.largeFile.pull` answered while
    /// the clone service is not running.
    ProjectCloneUnavailable = "project.clone.unavailable" (Unavailable, 503);
    /// An environment row's name refused at save, from `machine.settings.update` or
    /// `project.environment.update`.
    ProjectEnvironmentNameRefused = "project.environment.nameRefused" (InvalidArgument, 422);
    /// A project id that names no project this machine holds.
    ProjectNotFound = "project.notFound" (NotFound, 404);
    /// The account's plan allowance or credits are spent, shared by every provider call that spends
    /// from the account; `data.fields` carries the reset time when the provider gives one.
    ProviderAccountAllowanceExhausted = "provider.account.allowanceExhausted"
        (ResourceExhausted, 429);
    /// The account's credential home is missing, unreadable, or structurally unusable.
    ProviderAccountCredentialHomeUnavailable = "provider.account.credentialHome.unavailable"
        (Unavailable, 503);
    /// The place the daemon keeps its secrets would not take the token, so registration refuses
    /// and the token is stored nowhere else. `data.fields.cause` is `locked` or `unavailable`, each
    /// drawn as the title `Token not saved` over its line: `Unlock the keychain, then try again.`
    /// for `locked`, and `Secrets cannot be used right now. See Settings › Runtime.` for
    /// `unavailable`, the same on every system.
    ProviderAccountCredentialSealRefused = "provider.account.credentialSealRefused"
        (Unavailable, 503);
    /// A concurrent `provider.account.current.update` lost the partial-unique-index race.
    ProviderAccountCurrentConflict = "provider.account.current.conflict" (Aborted, 409);
    /// Accounts exist for the provider but none carries the current mark, so resolution is
    /// ambiguous and refuses rather than picking one.
    ProviderAccountCurrentNotSet = "provider.account.current.notSet" (FailedPrecondition, 409);
    /// The name given to an account added from a pasted token or API key repeats one of that
    /// provider's other account names, trimmed and compared by full Unicode case folding
    /// (`foldName`).
    ProviderAccountDisplayLabelTaken = "provider.account.displayLabelTaken" (AlreadyExists, 409);
    /// `provider.account.delete` refused because a run bound to the account is live.
    ProviderAccountInUse = "provider.account.inUse" (FailedPrecondition, 409);
    /// The account's sign-in is gone or the provider refused it: `provider.account.current.update`
    /// named a known-dead target (its stored reading is `reauthRequired`, or its last limits read
    /// showed its provider sign-in gone), or a provider call such as a voice call needed a sign-in.
    ProviderAccountNotAuthenticated = "provider.account.notAuthenticated" (FailedPrecondition, 409);
    /// The referenced `providerAccountId` is not present in the registry (never registered, or
    /// removed after the reference was taken).
    ProviderAccountNotFound = "provider.account.notFound" (NotFound, 404);
    /// No account is registered for the requested provider.
    ProviderAccountNotRegistered = "provider.account.notRegistered" (FailedPrecondition, 409);
    /// The caller is neither this machine's own client nor a linked device: a session asked for a
    /// registry verb.
    ProviderAccountPermissionDenied = "provider.account.permissionDenied" (PermissionDenied, 403);
    /// `provider.account.update` carried `displayLabel` for an account that carries no typed name:
    /// only an account added from a pasted token or API key is named by the person, and every other
    /// account is named by the identity its provider reports.
    ProviderAccountRenameRefused = "provider.account.renameRefused" (FailedPrecondition, 409);
    /// A brokered sign-in is already in flight for this account.
    ProviderAccountSignInInFlight = "provider.account.signInInFlight" (FailedPrecondition, 409);
    /// Brokered sign-in was requested for a provider whose pinned flow emits neither an
    /// authorization URL nor a device code, so there is nothing the person could act on.
    ProviderAccountSignInUnsupported = "provider.account.signInUnsupported" (Unimplemented, 422);
    /// The registration-time status invocation, run on a pasted token, reported no signed-in mode,
    /// so the provider did not accept the token.
    ProviderAccountTokenNotAccepted = "provider.account.tokenNotAccepted" (InvalidArgument, 422);
    /// Requested capability is not supported by the driver.
    ProviderCapabilityUnsupported = "provider.capability.unsupported" (Unimplemented, 422);
    /// Nothing runnable sits at the command path the person typed.
    ProviderCommandPathNotRunnable = "provider.commandPath.notRunnable" (InvalidArgument, 422);
    /// A per-place provider call named a WSL distribution that runs on WSL 1, where no session
    /// runs, naming it (`data.fields`: `distro`).
    ProviderDistributionNeedsWsl2 = "provider.distributionNeedsWsl2" (FailedPrecondition, 409);
    /// A per-place provider call named a WSL distribution that is not on this computer, naming it
    /// (`data.fields`: `distro`).
    ProviderDistributionNotFound = "provider.distributionNotFound" (InvalidArgument, 422);
    /// `provider.install.start` or `provider.installUpdate.start` named a place the provider ships
    /// no build for.
    ProviderNoBuildForSystem = "provider.noBuildForSystem" (FailedPrecondition, 409);
    /// The provider's command is not installed, so a setting that needs it cannot be turned on:
    /// availability for new sessions, the shared terminal service, and the terminal plugin.
    ProviderNotInstalled = "provider.notInstalled" (FailedPrecondition, 409);
    /// A provider id no registered driver answers to, such as a session made by a provider this
    /// build lacks.
    ProviderNotFound = "provider.notFound" (NotFound, 404);
    /// A per-place provider call named a place on macOS or Linux, which offer none.
    ProviderPlaceNotOffered = "provider.place.notOffered" (InvalidArgument, 422);
    /// A per-place provider call named no place on a computer where a WSL 2 distribution is.
    ProviderPlaceRequired = "provider.place.required" (InvalidArgument, 422);
    /// `provider.update` named a row the provider's driver does not declare.
    ProviderRowNotFound = "provider.row.notFound" (NotFound, 404);
    /// `provider.update` asked to stop an action row that is not running in that place.
    ProviderRowNotRunning = "provider.row.notRunning" (FailedPrecondition, 409);
    /// `provider.update` asked to stop an action row whose running progress says it cannot stop.
    ProviderRowNotStoppable = "provider.row.notStoppable" (FailedPrecondition, 409);
    /// `provider.update` set a row to a value its declaration refuses: another kind, a choice not
    /// listed or unavailable, a none the row does not offer, text past its length, or a place on a
    /// row that is not set per place.
    ProviderRowValueInvalid = "provider.row.valueInvalid" (InvalidArgument, 422);
    /// Provider driver operation timed out.
    ProviderTimeout = "provider.timeout" (DeadlineExceeded, 504);
    /// Provider driver is currently unavailable.
    ProviderUnavailable = "provider.unavailable" (Unavailable, 503);
    /// `question.resolve` was sent answers that do not cover every question of the record.
    QuestionAnswersIncomplete = "question.answersIncomplete" (InvalidArgument, 422);
    /// `question.resolve` was sent an answer its question cannot take, naming the question's page
    /// (`data.fields`: `page`) and why (`data.fields.reason`: `secretOnPlain`, `labelNotOffered`,
    /// `severalOnSingle` or `textOnChoice`).
    QuestionAnswerInvalid = "question.answerInvalid" (InvalidArgument, 422);
    /// `question.resolve` named a question the daemon does not hold.
    QuestionNotFound = "question.notFound" (NotFound, 404);
    /// `question.resolve` named a question the agent does not wait for, whose answer is a message
    /// sent through the queue.
    QuestionNotWaiting = "question.notWaiting" (FailedPrecondition, 409);
    /// `question.resolve` named a question that waits for its run to read running before it takes
    /// an answer.
    QuestionWaitingForRun = "question.waitingForRun" (FailedPrecondition, 409);
    /// Relay authentication failed.
    RelayAuthenticationFailed = "relay.authenticationFailed" (Unauthenticated, 401);
    /// Relay connection to the upstream service failed.
    RelayConnectionFailed = "relay.connectionFailed" (Unavailable, 502);
    /// The machine's forwarding object moved to another continent, so the relay closes the
    /// WebSocket with close code 4000 and a device reconnects through the negotiation's new answer.
    RelayForwardingObjectMoved = "relay.forwardingObject.moved" (Unavailable);
    /// A sign-in route of the relay refused a request over its rate limit.
    RelayRateLimited = "relay.rateLimited" (ResourceExhausted, 429);
    /// A request reached a sign-in route (sign-in, token refresh or device linking) with no source
    /// address the relay can count, so it is refused before anything is counted rather than counted
    /// in a bucket other callers share.
    RelaySourceAddressUnresolvable = "relay.sourceAddressUnresolvable" (InvalidArgument, 400);
    /// The machine refused a pinned relay whose key changed.
    RelaySpkiMismatch = "relay.spkiMismatch" (FailedPrecondition, 409);
    /// The resolved canonical root is already attached on this machine: a mount belongs to the
    /// machine, one per canonical root.
    RepoMountAlreadyAttached = "repoMount.alreadyAttached" (AlreadyExists, 409);
    /// Detach refused while an agent runs anywhere in the project, naming the running session
    /// (drawn `Busy: <session> is running in it.`).
    RepoMountDetachConflict = "repoMount.detachConflict" (FailedPrecondition, 409);
    /// `repoMount.attach`, `machine.folder.list` or `project.clone.start` refused because the
    /// folder's WSL distribution runs on WSL 1, naming the distribution (`data.fields`: `distro`).
    RepoMountDistributionNeedsWsl2 = "repoMount.distributionNeedsWsl2" (FailedPrecondition, 409);
    /// `repoMount.attach`, `machine.folder.list` or `project.clone.start` refused because no WSL
    /// distribution of the folder's name is on this computer, naming the name (`data.fields`:
    /// `distro`).
    RepoMountDistributionNotFound = "repoMount.distributionNotFound" (InvalidArgument, 422);
    /// The mount is a chat's managed workspace, which only that chat binds and only its purge
    /// removes: another session's bind, any detach and a `session.workingFolder.update` of the chat
    /// are refused, writing nothing (`data.fields`: `repoMountId`).
    RepoMountManaged = "repoMount.managed" (FailedPrecondition, 409);
    /// Repo mount does not exist, or is no longer attached for a bind or a project `session.create`
    /// to name.
    RepoMountNotFound = "repoMount.notFound" (NotFound, 404);
    /// A picked folder lies outside the project's admitted roots.
    RepoMountOutsideTrustEnvelope = "repoMount.outsideTrustEnvelope" (InvalidArgument, 422);
    /// `repoMount.reattach` refused, writing nothing, while an agent runs anywhere in the project.
    RepoMountReattachConflict = "repoMount.reattachConflict" (FailedPrecondition, 409);
    /// `repoMount.reattach` refused, writing nothing.
    RepoMountReattachRefused = "repoMount.reattachRefused" (FailedPrecondition, 409);
    /// Canonical repository root could not be resolved for the supplied path.
    RepoMountRootResolutionFailed = "repoMount.rootResolutionFailed" (InvalidArgument, 422);
    /// A call the client canceled with `$/cancelRequest` before the daemon reached its commit
    /// point.
    RequestCanceled = "request.canceled" (Canceled; RequestCanceled);
    /// The message is not a well-formed JSON-RPC envelope; over HTTP, a body that does not parse or
    /// carries no JSON content type.
    RequestEnvelopeInvalid = "request.envelopeInvalid" (InvalidArgument, 400; InvalidRequest);
    /// A control plane route called with an HTTP method it does not serve.
    RequestMethodNotAllowed = "request.methodNotAllowed" (InvalidArgument, 405);
    /// The request names a method the daemon does not register; no handler runs.
    RequestMethodNotFound = "request.methodNotFound" (Unimplemented, 404; MethodNotFound);
    /// The request's params failed the method's contract check, so no handler ran.
    RequestParamsInvalid = "request.paramsInvalid" (InvalidArgument, 422; InvalidParams);
    /// Per-request envelope-level `protocolVersion` field violates, the wrong JSON type, or fails
    /// the ISO 8601 `YYYY-MM-DD` shape.
    RequestProtocolVersionInvalid = "request.protocolVersion.invalid"
        (InvalidArgument, 400; InvalidRequest);
    /// The handler's result failed the method's result check: a daemon fault, never the client's.
    RequestResultInvalid = "request.resultInvalid" (Internal; InternalError);
    /// Session has already been closed and cannot be modified.
    SessionAlreadyClosed = "session.alreadyClosed" (FailedPrecondition, 409);
    /// A file `session.attachment.add` did not stage.
    SessionAttachmentRefused = "session.attachment.refused" (InvalidArgument, 422);
    /// A change the session's state does not take: a `provisioning` session is neither archived,
    /// closed nor converted, and a `purgeRequested` one, being deleted, takes no change.
    SessionChangeRefused = "session.changeRefused" (FailedPrecondition, 409);
    /// A conversion stopped after the repository was attached.
    SessionConversionIncomplete = "session.conversion.incomplete" (Internal, 500);
    /// `session.convert` named a session that is not a chat, a chat with no managed workspace to
    /// convert (`data.fields.reason: noManagedWorkspace`), a `clientIdempotencyKey` another
    /// session's conversion holds (`reason: idempotencyKeyReused`), a folder other than the one a
    /// chat's stopped conversion copies into (`reason: conversionUnfinished`, with that
    /// conversion's `repoMountId`), or a folder outside the chat's place, which never changes
    /// (`reason: folderInAnotherPlace`, with the chat's `place`).
    SessionConversionRefused = "session.conversion.refused" (FailedPrecondition, 409);
    /// An `EventCursor` a session event or transcript read names cannot be decoded to a log
    /// position.
    SessionEventCursorUnresolvable = "session.event.cursorUnresolvable" (InvalidArgument, 400);
    /// `session.group.create` or `session.group.rename` named a group another group of the
    /// session's project already holds, ignoring case.
    SessionGroupNameTaken = "session.group.nameTaken" (AlreadyExists, 409);
    /// `session.group.create`, `session.group.move` or `session.create`'s `groupId` asked to put a
    /// chat in a group, or a session in a group of another project.
    SessionGroupRefused = "session.group.refused" (InvalidArgument, 422);
    /// A write to a session whose history is degraded or damaged, at the wire for a call naming the
    /// session and at the append for any of its events (`data.fields`: `sessionId`, `recovery`).
    SessionHistoryDamaged = "session.history.damaged" (FailedPrecondition, 409);
    /// `session.link.remove` named a link the daemon wrote from an event (`started`, `copiedFrom`,
    /// `messaged`, `asked`, `mentioned`), which records what happened.
    SessionLinkNotRemovable = "session.link.notRemovable" (FailedPrecondition, 409);
    /// The session's provider refused a message, a steer or a queued message as longer than its
    /// own limit, so none of it reached the conversation (`data.fields`:
    /// `SessionMessageTooLargeDetails`).
    SessionMessageTooLarge = "session.message.tooLarge" (ResourceExhausted, 413);
    /// A mode the session's provider refused to move to, sent on `session.mode.update`: the mode
    /// stays where it was.
    SessionModeNotOffered = "session.mode.notOffered" (InvalidArgument, 422);
    /// Session does not exist.
    SessionNotFound = "session.notFound" (NotFound, 404);
    /// A permission level the session's provider, its account or its model cannot run, sent on
    /// `session.permissionLevel.update` or as `plan.resolve`'s `fresh.level`.
    SessionPermissionLevelNotOffered = "session.permissionLevel.notOffered" (InvalidArgument, 422);
    /// A write to a session the restart's recovery pass has not rebuilt yet, at the wire for a call
    /// naming the session and at the append for any of its events but the pass's own; retry
    /// (`data.fields`: `sessionId`).
    SessionRebuilding = "session.rebuilding" (Unavailable, 503);
    /// `session.recovery.continue` or `session.recovery.delete` named a session the refusal does
    /// not fit.
    SessionRecoveryRefused = "session.recovery.refused" (FailedPrecondition, 409);
    /// Raised by `session.reviewNote.update` and `session.reviewNote.add`.
    SessionReviewNoteNotFound = "session.reviewNote.notFound" (NotFound, 404);
    /// The model refused a `session.sideQuestion.ask` question, so no answer lands
    /// (`data.fields`: `sessionId`, `sideQuestionId`, `cause`, the refusal as the provider gave it).
    SessionSideQuestionRefused = "session.sideQuestion.refused" (FailedPrecondition, 409);
    /// A `session.search` `afterCursor` the daemon did not write, one written for another query, or
    /// one whose search the daemon no longer holds.
    SessionSearchCursorUnresolvable = "session.search.cursorUnresolvable" (InvalidArgument, 400);
    /// A `session.file.search` whose session has no working folder in place, yet or any more,
    /// nothing being listed, or a `session.workingFolder.update` whose session works in no folder
    /// any more, nothing being moved.
    SessionWorkingFolderMissing = "session.workingFolder.missing" (FailedPrecondition, 409);
    /// A save would rename a folder of ours onto a name another folder of ours already holds in the
    /// same place.
    SkillNameTaken = "skill.nameTaken" (AlreadyExists, 409);
    /// A skill's name is longer than the name limit of a provider the skill is on
    /// (`data.fields`: `SkillNameTooLongDetails`).
    SkillNameTooLong = "skill.nameTooLong" (InvalidArgument, 422);
    /// `skill.update` refused a path in the folder it would save, or `agent.queueItem.create`
    /// refused a picked skill whose name and folder match no row of `skill.list`, or, for an agent
    /// whose provider keeps its own skill list, no skill that list names in that folder.
    SkillPathRefused = "skill.pathRefused" (InvalidArgument, 422);
    /// A write to a skill was refused.
    SkillWriteRefused = "skill.writeRefused" (FailedPrecondition, 409);
    /// Unexpected internal error.
    SystemInternalError = "system.internalError" (Internal, 500; InternalError);
    /// System is undergoing maintenance.
    SystemMaintenance = "system.maintenance" (Unavailable, 503);
    /// The PTY a shell needs cannot be opened: `sidekicks-terminal` in the daemon could not create
    /// it (`ConPTY` on Windows, `alacritty_terminal`'s tty elsewhere).
    TerminalBackendUnavailable = "terminal.backendUnavailable" (Unavailable, 503);
    /// `terminal.open` on a chat session, which is bound to a managed workspace and no repository
    /// and has no shell.
    TerminalChatUnsupported = "terminal.chatUnsupported" (FailedPrecondition, 409);
    /// `terminal.control.take`, a resize, a pane's appearance report or a close refused for the
    /// named shell because someone else holds it.
    TerminalControlHeldByOther = "terminal.control.heldByOther" (FailedPrecondition, 409);
    /// A write from a connection the shell's hold is not bound to.
    TerminalControlNotHeld = "terminal.control.notHeld" (FailedPrecondition, 409);
    /// A request naming a shell its session does not have: no shell by that terminal id, or another
    /// session's shell, which the refusal never tells apart.
    TerminalNotFound = "terminal.notFound" (NotFound, 404);
    /// `terminal.control.take` or `terminal.write` naming an output subscription that is not one
    /// the calling connection holds open from `terminal.output.subscribe` on the named shell: no
    /// such subscription, another connection's, or one to another shell, which the refusal never
    /// tells apart.
    TerminalOutputSubscriptionNotFound = "terminal.output.subscriptionNotFound" (NotFound, 404);
    /// A terminal write that found its connection's writes to that shell at their waiting limit.
    TerminalWriteLimitReached = "terminal.write.limitReached" (ResourceExhausted);
    /// A `transcript.body.read` offset that is no place to resume from: inside a character or past
    /// the body's end (`data.fields`: `offset`, `bodyLength`).
    TranscriptBodyOffsetInvalid = "transcript.body.offsetInvalid" (InvalidArgument, 422);
    /// A transcript read named a row the session does not hold: an anchor cursor or a row id at
    /// which no row of the session's transcript stands.
    TranscriptRowNotFound = "transcript.row.notFound" (NotFound, 404);
    /// Voice refused on a signed-in account whose sign-in kind its provider gives no voice
    /// (`data.fields`: `VoiceAccountNotEntitledDetails`).
    VoiceAccountNotEntitled = "voice.accountNotEntitled" (PermissionDenied, 403);
    /// The provider could not start the call `voice.call.start` asked for, for a passing reason:
    /// its realtime service or the network failed, or the call closed before its answer.
    VoiceCallStartFailed = "voice.call.startFailed" (Unavailable, 503);
    /// A full-tier Code step whose package install did not finish.
    WorkflowCodeInstallFailed = "workflow.code.installFailed" (Internal, 500);
    /// A Code step over its memory budget, 256 MiB per node by default and settable.
    WorkflowCodeOverBudget = "workflow.code.overBudget" (ResourceExhausted, 422);
    /// A start of a workflow version whose Code steps' packages are not locked.
    WorkflowCodePackagesNotLocked = "workflow.code.packagesNotLocked" (FailedPrecondition, 409);
    /// A `workflow.run.list`, `workflow.step.read` or `workflow.definition.list` `cursor` the
    /// daemon did not write, or one past the end of what it pages; nothing is read.
    WorkflowCursorUnresolvable = "workflow.cursorUnresolvable" (InvalidArgument, 400);
    /// An import whose schema version is unknown.
    WorkflowDefinitionImportSchemaUnknown = "workflow.definition.importSchemaUnknown"
        (InvalidArgument, 422);
    /// A workflow definition that does not exist.
    WorkflowDefinitionNotFound = "workflow.definition.notFound" (NotFound, 404);
    /// A saved or imported document the daemon's own re-check refuses.
    WorkflowDefinitionRefused = "workflow.definition.refused" (InvalidArgument, 422);
    /// A form draft save or a form submit carrying a revision that is no longer current.
    WorkflowHumanFormRevisionStale = "workflow.humanForm.revisionStale" (Aborted, 409);
    /// A run or step move its status does not allow: retrying from a step that did not fail,
    /// posting the results of an unfinished run, or opening a fix session on a step that did not
    /// fail.
    WorkflowInvalidTransition = "workflow.invalidTransition" (FailedPrecondition, 409);
    /// A `workflow.run.start`, `workflow.run.retry` or `workflow.run.rerun` reused a
    /// `clientIdempotencyKey` with a differing payload; the run the key first answered is
    /// untouched. A resend with the same payload is not refused: it answers that run.
    WorkflowRunIdempotencyConflict = "workflow.run.idempotencyConflict" (InvalidArgument, 422);
    /// A start that leaves a required input its workflow declares unfilled, or gives an input a
    /// value that does not fit it.
    WorkflowRunInputRequired = "workflow.run.inputRequired" (InvalidArgument, 422);
    /// `workflow.run.cancel` refused because the run has ended, so there is nothing to cancel and
    /// reporting success would misinform the person about what their action did.
    WorkflowRunNotCancelable = "workflow.run.notCancelable" (FailedPrecondition, 409);
    /// `Delete run` on a run that is `new`, `running` or `waiting` or is a failed run parked on its
    /// failed step, or on a chain's first run while a later run of its chain is one of those, drawn
    /// `Cancel it first.`.
    WorkflowRunNotDeletable = "workflow.run.notDeletable" (FailedPrecondition, 409);
    /// A workflow run that does not exist.
    WorkflowRunNotFound = "workflow.run.notFound" (NotFound, 404);
    /// A `workflow.run.start` from a project session that names a project: that session's run works
    /// in the session's own repository, so nothing runs.
    WorkflowRunProjectOnProjectSession = "workflow.run.projectOnProjectSession"
        (InvalidArgument, 422);
    /// Frozen-definition re-pin refused: a step of the run is still in flight.
    WorkflowRunRepairAttemptInFlight = "workflow.run.repairAttemptInFlight"
        (FailedPrecondition, 409);
    /// Frozen-definition re-pin refused: the target run is not parked.
    WorkflowRunRepairNotParked = "workflow.run.repairNotParked" (FailedPrecondition, 409);
    /// Frozen-definition re-pin refused: the target version cannot account for the nodes the run
    /// has already completed.
    WorkflowRunRepairVersionUnaccountable = "workflow.run.repairVersionUnaccountable"
        (FailedPrecondition, 409);
    /// A start, or a node run (`workflow.node.execute`), that names no project's repository.
    WorkflowRunRepositoryRequired = "workflow.run.repositoryRequired" (InvalidArgument, 422);
    /// `workflow.run.resume` refused because the target run is not parked.
    WorkflowRunResumeNotParked = "workflow.run.resumeNotParked" (FailedPrecondition, 409);
    /// Workflow run start refused by Cedar under `Action::"workflow::start"`, or whose principal
    /// could not be resolved: an agent's start, or a run a trigger fires, judged when it fires with
    /// the person recorded as its starter.
    WorkflowRunStartDenied = "workflow.run.startDenied" (PermissionDenied, 403);
    /// `Retry from this step` refused while the source run is still going.
    WorkflowRunStillRunning = "workflow.run.stillRunning" (FailedPrecondition, 409);
    /// A full-tier Code step, or a shell step at the Sandboxed level, whose provider sandbox did
    /// not start.
    WorkflowSandboxUnavailable = "workflow.sandboxUnavailable" (Unavailable, 503);
    /// A secret name refused at save by its pattern.
    WorkflowSecretNameInvalid = "workflow.secret.nameInvalid" (InvalidArgument, 422);
    /// A secret name already in use, refused at save.
    WorkflowSecretNameTaken = "workflow.secret.nameTaken" (AlreadyExists, 409);
    /// A secret reference the keychain does not hold.
    WorkflowSecretNotFound = "workflow.secret.notFound" (NotFound, 404);
    /// The keychain is locked or unavailable.
    WorkflowSecretStoreUnavailable = "workflow.secret.storeUnavailable" (Unavailable, 503);
    /// A step key that does not exist in its run.
    WorkflowStepNotFound = "workflow.step.notFound" (NotFound, 404);
    /// A form submitted, an approval answered or a form read on a step that is no longer waiting.
    WorkflowStepNotWaiting = "workflow.step.notWaiting" (FailedPrecondition, 409);
    /// A quick step's engine that could not be started: its thread, `rquickjs` runtime or context
    /// could not be created.
    WorkflowStepThreadFailed = "workflow.step.threadFailed" (Internal, 500);
    /// A step or a run cut by a time limit, read `failed · timed out`.
    WorkflowStepTimedOut = "workflow.step.timedOut" (DeadlineExceeded, 504);
    /// A trigger that cannot be armed.
    WorkflowTriggerUnarmable = "workflow.trigger.unarmable" (FailedPrecondition, 409);
    /// A `workflow.version.diff.read` naming two versions of different workflows; nothing is
    /// compared.
    WorkflowVersionDiffCrossWorkflow = "workflow.version.diffCrossWorkflow" (InvalidArgument, 422);
    /// A workflow version that does not exist.
    WorkflowVersionNotFound = "workflow.version.notFound" (NotFound, 404);
    /// A save against a stale definition version.
    WorkflowVersionStale = "workflow.version.stale" (Aborted, 409);
    /// A webhook call with the wrong token or an unknown hook id, or any call while no token
    /// exists.
    WorkflowWebhookTokenMismatch = "workflow.webhookToken.mismatch" (Unauthenticated, 401);
    /// A wire-initiated (pre-run) `workspace.executionRoot.prepare` for a `provisionedWorktree`
    /// omitted `branchName`: the slug rule's derivation inputs (queue-item summary / run id) exist
    /// only on the run-setup gate path, so wire prepares must carry the branch.
    WorkspaceBranchNameRequired = "workspace.branchNameRequired" (InvalidArgument, 400);
    /// A repo-bound run reached the setup gate with no resolved execution root for the workspace's
    /// selected mode and root preparation failed.
    WorkspaceExecutionRootUnresolved = "workspace.executionRoot.unresolved"
        (FailedPrecondition, 409);
    /// A worktree was requested for a chat's managed workspace, which offers only its own root.
    WorkspaceModeUnsupported = "workspace.modeUnsupported" (InvalidArgument, 422);
    /// Workspace does not exist.
    WorkspaceNotFound = "workspace.notFound" (NotFound, 404);
    /// Preparing the workspace failed due to an internal error.
    WorkspacePreparationFailed = "workspace.preparationFailed" (Internal, 500);
    /// The workspace's working root is unavailable.
    WorkspaceRootUnavailable = "workspace.rootUnavailable" (FailedPrecondition, 409);
    /// Caller-supplied branch name collides with a live checkout on the same mount.
    WorktreeBranchCollision = "worktree.branchCollision" (AlreadyExists, 409);
    /// Worktree creation failed (git error, filesystem error, or dynamic worktree unavailability at
    /// preparation time).
    WorktreeCreateFailed = "worktree.createFailed" (Internal, 500);
    /// Worktree does not exist.
    WorktreeNotFound = "worktree.notFound" (NotFound, 404);
    /// `worktree.restore` or `worktree.removed.delete` named a kept worktree that does not
    /// exist, such as one a put-back or deletion queued before it already removed.
    WorktreeRemovedNotFound = "worktree.removed.notFound" (NotFound, 404);
    /// `worktree.retire` with `discard: false` refused.
    WorktreeRetireConflict = "worktree.retireConflict" (FailedPrecondition, 409);
    /// `worktree.retire` with `discard: true` refused because the operating system refused the
    /// move-aside rename while a program outside the app holds a file in the worktree open.
    WorktreeRetireFolderHeld = "worktree.retireFolderHeld" (FailedPrecondition, 409);
    /// `worktree.retire` with `discard: true` refused because the move across volumes copied
    /// the tree whole to its kept place but could not remove the original completely.
    WorktreeRetireIncomplete = "worktree.retireIncomplete" (FailedPrecondition, 409);
}

/// The TypeScript module that owns the refusal union.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: RefusalCode::TYPESCRIPT_MODULE_PATH,
    doc: "Every refusal code a daemon method or a control plane route answers with.",
    definitions: &[
        Definition::read::<KnownRefusalCategory>(),
        Definition::read::<RefusalCategory>(),
    ],
    constants: &[],
    method_tables: &[],
};
