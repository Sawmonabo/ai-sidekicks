//! The session directory as a client reads and moves it: the live sessions list and its entries,
//! creating a session (where it works and who leads it), converting a chat to a project, forking a
//! session, moving its working folder, the terminal pane's overview, and the method table for these
//! verbs and for `session.event.subscribe`, whose frames carry each event as its envelope, so a
//! type the wire has no payload variant for still parses.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::IntoStaticStr;

use crate::agent::definition::binding::{AgentProviderBinding, provider_binding};
use crate::free_form_string::FilesystemPath;
use crate::jsonrpc::page::{PAGE_MAX_BYTES, fits_one_page};
use crate::jsonrpc::streaming::{SubscribeAcknowledgmentResponse, SubscriptionId};
use crate::method::KeyedRequest;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::place::Place;
use crate::project::ProjectId;
use crate::provider::driver::length_limits::PROVIDER_TOOL_NAME_MAX_LEN;
use crate::provider::id::ProviderId;
use crate::repo::mount::ExecutionMode;
use crate::session::convert::{SessionConvertRequest, SessionConvertResponse};
use crate::session::event_cursor::EventCursor;
use crate::session::groups::SessionGroupId;
use crate::session::id::SessionId;
use crate::session::methods::{
    SessionEventSubscribeRequest, SessionShape, SessionState, SessionStreamFrame,
};
use crate::session::name::SESSION_NAME_MAX_LEN;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::id::ClientUuid;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::list::BoundedVec;
use crate::wire::text::FreeFormText;
use crate::wire::{Never, literal};
use crate::worktree::lifecycle::WorktreeId;

/// What a session is doing, as the daemon derives it: exactly one of five, and no client invents a
/// sixth. `waiting` is waiting on the person; `failed` is a session that died, kept apart from one
/// that finished (`done`).
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, IntoStaticStr,
)]
#[serde(rename_all = "camelCase")]
#[strum(serialize_all = "camelCase")]
pub enum SessionActivity {
    /// Working.
    Running,
    /// Waiting on the person.
    Waiting,
    /// Finished.
    Done,
    /// Died.
    Failed,
    /// Neither working nor waiting.
    Idle,
}

/// How often the daemon republishes a quiet running or waiting session's entry.
pub const SESSION_ACTIVITY_RENEW_INTERVAL_MS: i64 = 15_000;
ts_constants! {
    /// How old a `running` or `waiting` reading may be before a reader stops believing it: three
    /// missed renewals, so a daemon that stopped publishing never leaves a row claiming work.
    pub const SESSION_ACTIVITY_STALE_AFTER_MS: i64 = 45_000;
}

/// The activity a reader shows at `now_ms` (milliseconds since the Unix epoch) for an entry whose
/// `activity` was renewed at `activity_renewed_at`: a `running` or `waiting` reading renewed longer
/// ago than [`SESSION_ACTIVITY_STALE_AFTER_MS`] reads as `idle`. Every other word stands as
/// published; a `failed` session never ages out of being failed.
pub fn session_activity_as_of(
    activity: SessionActivity,
    activity_renewed_at: &WireInstant,
    now_ms: i64,
) -> SessionActivity {
    if !matches!(
        activity,
        SessionActivity::Running | SessionActivity::Waiting
    ) {
        return activity;
    }
    match activity_renewed_at.unix_millisecond() {
        Some(renewed_ms) if now_ms - renewed_ms > SESSION_ACTIVITY_STALE_AFTER_MS => {
            SessionActivity::Idle
        }
        _ => activity,
    }
}

/// The line a session's row shows in place of its branch or document count while it trades
/// messages with another session: the other session and how many messages the two have traded
/// since the person last wrote in either.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionExchange {
    /// The other session.
    pub peer_session_id: SessionId,
    /// Its name.
    pub peer_name: FreeFormText<SESSION_NAME_MAX_LEN>,
    /// The messages traded.
    pub message_count: SafeInt<1>,
}

/// The group of its project a session sits in, named as the list draws it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionListGroup {
    /// The group.
    pub group_id: SessionGroupId,
    /// Its name.
    pub name: FreeFormText<SESSION_NAME_MAX_LEN>,
}

/// Declares one arm of [`SessionListEntry`]: the members every row draws, then the arm's own.
macro_rules! session_list_entry_arm {
    ($(#[$attribute:meta])+ pub struct $name:ident { $($arm:tt)* }) => {
        $(#[$attribute])+
        pub struct $name {
            /// The session.
            pub session_id: SessionId,
            /// Its name; absent while untitled, when the row shows `firstMessagePreview`.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
            pub name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
            /// The first message's opening; absent before the first message.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
            pub first_message_preview: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
            /// Its lifecycle state; archived and closed sessions sit in the `Archived` group.
            pub state: SessionState,
            /// The row's state word.
            pub activity: SessionActivity,
            /// When the daemon last published `activity`.
            #[garde(dive)]
            pub activity_renewed_at: WireInstant,
            /// Present exactly while the session is pinned; pinned rows sit in pin order.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "WireInstant")]
            #[garde(dive)]
            pub pinned_at: Option<WireInstant>,
            /// Whether the person muted the session's notifications.
            pub muted: bool,
            /// Present while the session trades messages with another.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "SessionExchange")]
            pub exchange: Option<SessionExchange>,
            /// The age the row shows.
            #[garde(dive)]
            pub last_activity_at: WireInstant,
            $($arm)*
        }
    };
}

session_list_entry_arm! {
    /// A project session's row: its project, once known its branch, and its group while in one.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[schemars(inline)]
    #[garde(allow_unvalidated)]
    pub struct SessionListProjectEntry {
        /// The project.
        pub project_id: ProjectId,
        /// The branch the daemon holds for the session, so the row costs no git read.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "FreeFormText<{ usize::MAX }>")]
        pub branch: Option<FreeFormText<{ usize::MAX }>>,
        /// The group it sits in.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SessionListGroup")]
        pub group: Option<SessionListGroup>,
    }
}

session_list_entry_arm! {
    /// A chat's row: its document count, the files in the chat's own folder, which the daemon
    /// keeps as they change so the row costs no folder walk. A chat sits in no group.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    #[schemars(inline)]
    #[garde(allow_unvalidated)]
    pub struct SessionListChatEntry {
        /// The files in the chat's folder; absent while the folder is being made.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SafeInt<0>")]
        pub document_count: Option<SafeInt<0>>,
    }
}

/// One row of the sessions list, everything the row draws from one feed so the list opens no
/// stream per session, split on `shape`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(tag = "shape", rename_all = "camelCase")]
pub enum SessionListEntry {
    /// A project session.
    Project(#[garde(dive)] SessionListProjectEntry),
    /// A chat.
    Chat(#[garde(dive)] SessionListChatEntry),
}

/// `session.subscribe`'s acknowledgment: the subscription, the first page of every session as it
/// stands, and `chatCount`, the chats in the live list as the daemon counts them, so no reader
/// counts. While `isComplete` is false the rest of the list follows as `page` changes, before any
/// other change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionSubscribeResponse {
    /// The subscription.
    pub subscription_id: SubscriptionId,
    /// The first page of sessions.
    #[garde(dive, custom(fits_one_page))]
    #[schemars(extend("maxJsonBytes" = PAGE_MAX_BYTES))]
    pub sessions: Vec<SessionListEntry>,
    /// The chats in the live list.
    pub chat_count: SafeInt<0>,
    /// Whether the list is whole.
    pub is_complete: bool,
}

/// One change to the list after the acknowledgment, each carrying `chatCount` as it stands after
/// the change.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum SessionListChange {
    /// A further page of the opening list.
    Page {
        /// The sessions, at least one.
        #[garde(dive, custom(fits_one_page))]
        #[schemars(extend("maxJsonBytes" = PAGE_MAX_BYTES))]
        sessions: BoundedVec<SessionListEntry, 1, { usize::MAX }>,
        /// The chats in the live list.
        chat_count: SafeInt<0>,
        /// Whether the list is now whole.
        is_complete: bool,
    },
    /// An entry as it now stands.
    Upsert {
        /// The entry.
        #[garde(dive)]
        entry: Box<SessionListEntry>,
        /// The chats in the live list.
        chat_count: SafeInt<0>,
    },
    /// A session that has left the list, which only a purge does.
    Remove {
        /// The session.
        session_id: SessionId,
        /// The chats in the live list.
        chat_count: SafeInt<0>,
    },
}

literal! {
    /// The `chat` word of a binding.
    pub enum ChatBindingKind = "chat";
    /// The `project` word of a binding.
    pub enum ProjectBindingKind = "project";
}

/// A chat works in a managed workspace the daemon makes for it in the same step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionChatBinding {
    /// `chat`.
    pub kind: ChatBindingKind,
}

/// A project session binds to the project's mount in the same step, working in a worktree of its
/// own (`provisionedWorktree`) or in the project's checkout (`boundRoot`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionProjectBinding {
    /// `project`.
    pub kind: ProjectBindingKind,
    /// The project.
    pub project_id: ProjectId,
    /// Where in it the session works.
    pub execution_mode: ExecutionMode,
}

/// Where a new session works, split on `kind`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum SessionBinding {
    /// A managed workspace.
    Chat(SessionChatBinding),
    /// A project's mount.
    Project(SessionProjectBinding),
}

provider_binding! {
    /// The lead as the app chose it: its provider, model and effort, and its output speed where one
    /// was picked. It names no account: the daemon resolves that.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct SessionLead {}
}

/// `session.create` for a project session, which may be filed in a group of its project.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SessionCreateProjectRequest {
    /// The key that makes a repeated create one session.
    pub client_idempotency_key: ClientUuid,
    /// The project's mount.
    pub binding: SessionProjectBinding,
    /// The lead, as the app chose it; a session is born with its lead.
    pub lead: SessionLead,
    /// The group of its project to file the session in.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionGroupId")]
    pub group_id: Option<SessionGroupId>,
}

/// `session.create` for a chat, which sits in no group.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SessionCreateChatRequest {
    /// The key that makes a repeated create one session.
    pub client_idempotency_key: ClientUuid,
    /// The managed workspace.
    pub binding: SessionChatBinding,
    /// The lead, as the app chose it; a session is born with its lead.
    pub lead: SessionLead,
    /// Never present: a chat sits in no group.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub group_id: Option<Never>,
}

/// What `session.create` takes: where the session works and who leads it. Only a project session
/// is filed in a group.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
#[garde(allow_unvalidated)]
pub enum SessionCreateRequest {
    /// A project session.
    Project(SessionCreateProjectRequest),
    /// A chat.
    Chat(SessionCreateChatRequest),
}

impl KeyedRequest for SessionCreateRequest {}

/// What `session.create` answers. `lead` is the binding the daemon resolved for the lead, the
/// account among it; `place` is where the session runs, its project's place, or for a chat the
/// place its provider is installed in.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionCreateResponse {
    /// The session.
    pub session_id: SessionId,
    /// Its shape.
    pub shape: SessionShape,
    /// Its state.
    pub state: SessionState,
    /// Where it runs, written at its creation and never changed; absent on macOS and Linux.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
    /// The lead's resolved binding.
    pub lead: AgentProviderBinding,
}

/// Forks a session from a message: a new session of the same shape carrying every row up to and
/// including `anchorCursor`. Absent `name` leaves the fork untitled.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionForkRequest {
    /// The session.
    pub session_id: SessionId,
    /// The last message the fork carries.
    pub anchor_cursor: EventCursor,
    /// The fork's name.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
    pub name: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// The key that makes a repeated fork one fork.
    pub client_idempotency_key: ClientUuid,
}

impl KeyedRequest for SessionForkRequest {}

/// The fork. A project fork lands on a new worktree cut from the parent's current one; a chat fork
/// gets its own managed workspace and has no worktree.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "shape",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum SessionForkResponse {
    /// A project fork.
    Project {
        /// The fork.
        session_id: SessionId,
        /// Its worktree.
        worktree_id: WorktreeId,
    },
    /// A chat fork.
    Chat {
        /// The fork.
        session_id: SessionId,
    },
}

/// Moves a project session's working folder to `path`: the folder of any worktree git lists for the
/// project's repository, or the repository's own checkout. Asking for the folder the session is
/// already in cancels a pending move, and a later request replaces a pending one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionWorkingFolderUpdateRequest {
    /// The session.
    pub session_id: SessionId,
    /// The folder.
    pub path: FilesystemPath,
}

/// When a working-folder move takes effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SessionWorkingFolderDisposition {
    /// The session moved now, or the request cleared a pending move.
    Applied,
    /// A run was live, and the move waits for it to end.
    Pending,
}

/// The `session.workingFolder.update` result.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionWorkingFolderUpdateResponse {
    /// The session.
    pub session_id: SessionId,
    /// When the move takes effect.
    pub disposition: SessionWorkingFolderDisposition,
    /// The folder.
    pub path: FilesystemPath,
}

/// The terminal pane's held read. The daemon answers once its sessions list or any session's agent
/// list moves past `afterRevision`, or after 10 s with nothing changed.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate,
)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionOverviewReadRequest {
    /// The revision the pane last drew.
    pub after_revision: SafeInt<0>,
}

/// One agent under a session in the terminal pane.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionOverviewAgent {
    /// The agent's name.
    pub name: FreeFormText<PROVIDER_TOOL_NAME_MAX_LEN>,
    /// Its provider.
    pub provider: ProviderId,
    /// What it is doing.
    pub state: SessionActivity,
}

/// One session in the terminal pane; `title` is absent while the session is untitled.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionOverviewSession {
    /// The session.
    pub id: SessionId,
    /// Its title.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "FreeFormText<SESSION_NAME_MAX_LEN>")]
    pub title: Option<FreeFormText<SESSION_NAME_MAX_LEN>>,
    /// Its lead's provider.
    pub provider: ProviderId,
    /// What it is doing.
    pub state: SessionActivity,
    /// Its agents.
    pub agents: Vec<SessionOverviewAgent>,
}

/// Whether Remote Control is on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RemoteControlState {
    /// On.
    On,
    /// Off.
    Off,
}

/// Remote Control as the terminal pane draws it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct SessionOverviewRemoteControl {
    /// Its state.
    pub state: RemoteControlState,
}

/// What the terminal pane draws: every session with its agents and Remote Control's state, read
/// from the projections behind `session.subscribe` and `agent.subscribe`. The next read sends
/// `revision` back as `afterRevision`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionOverviewReadResponse {
    /// The revision drawn.
    pub revision: SafeInt<0>,
    /// The sessions.
    pub sessions: Vec<SessionOverviewSession>,
    /// Remote Control.
    pub remote_control: SessionOverviewRemoteControl,
}

methods! {
    /// The session directory methods' wire contract: name, procedure type and types.
    pub const SESSION_DIRECTORY_METHOD_DESCRIPTORS = [
        /// Creates a session with its lead.
        SessionCreate = mutation "session.create" {
            mutating: true,
            params: SessionCreateRequest,
            result: SessionCreateResponse,
            refusals: [
                ProjectNotFound,
                RepoMountNotFound,
                SessionGroupRefused,
                ProviderAccountCurrentNotSet,
                ProviderAccountNotRegistered,
                AgentProviderAxisInvalid,
            ],
        },
        /// Follows the sessions list.
        SessionSubscribe = subscription "session.subscribe" {
            mutating: false,
            params: EmptyPayload,
            result: SessionSubscribeResponse,
            emission: SessionListChange,
            refusals: [],
        },
        /// Follows one session's events.
        SessionEventSubscribe = subscription "session.event.subscribe" {
            mutating: false,
            params: SessionEventSubscribeRequest,
            result: SubscribeAcknowledgmentResponse,
            emission: SessionStreamFrame,
            refusals: [SessionNotFound, SessionEventCursorUnresolvable],
        },
        /// Converts a chat to a project.
        SessionConvert = mutation "session.convert" {
            mutating: true,
            params: SessionConvertRequest,
            result: SessionConvertResponse,
            refusals: [
                SessionNotFound,
                SessionAlreadyClosed,
                SessionChangeRefused,
                SessionConversionRefused,
                SessionConversionIncomplete,
                RepoMountRootResolutionFailed,
                RepoMountAlreadyAttached,
            ],
        },
        /// Forks a session from a message.
        SessionFork = mutation "session.fork" {
            mutating: true,
            params: SessionForkRequest,
            result: SessionForkResponse,
            refusals: [SessionNotFound],
        },
        /// Moves a project session's working folder.
        SessionWorkingFolderUpdate = mutation "session.workingFolder.update" {
            mutating: true,
            params: SessionWorkingFolderUpdateRequest,
            result: SessionWorkingFolderUpdateResponse,
            refusals: [
                SessionNotFound,
                RepoMountManaged,
                SessionWorkingFolderMissing,
                RepoMountRootResolutionFailed,
                RepoMountOutsideTrustEnvelope,
                WorkspaceRootUnavailable,
            ],
        },
        /// The terminal pane's held read.
        SessionOverviewRead = query "session.overview.read" {
            mutating: false,
            params: SessionOverviewReadRequest,
            result: SessionOverviewReadResponse,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/directory",
    doc: "The session directory as a client reads and moves it: the live sessions list, creating, \
          converting and forking a session, moving its working folder, and the terminal pane's \
          overview.",
    definitions: &[
        Definition::read::<SessionActivity>(),
        Definition::read::<SessionExchange>(),
        Definition::read::<SessionListGroup>(),
        Definition::read::<SessionListEntry>(),
        Definition::read::<SessionSubscribeResponse>().checked(),
        Definition::read::<SessionListChange>().checked(),
        Definition::read::<SessionChatBinding>(),
        Definition::read::<SessionProjectBinding>(),
        Definition::read::<SessionBinding>().checked(),
        Definition::read::<SessionLead>(),
        Definition::read::<SessionCreateRequest>().checked(),
        Definition::read::<SessionCreateResponse>().checked(),
        Definition::read::<SessionForkRequest>().checked(),
        Definition::read::<SessionForkResponse>().checked(),
        Definition::read::<SessionWorkingFolderUpdateRequest>().checked(),
        Definition::read::<SessionWorkingFolderDisposition>(),
        Definition::read::<SessionWorkingFolderUpdateResponse>().checked(),
        Definition::read::<SessionOverviewReadRequest>().checked(),
        Definition::read::<SessionOverviewAgent>(),
        Definition::read::<SessionOverviewSession>(),
        Definition::read::<RemoteControlState>(),
        Definition::read::<SessionOverviewReadResponse>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&SESSION_DIRECTORY_METHOD_DESCRIPTORS],
};

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::{SessionActivity, session_activity_as_of};
    use crate::wire::instant::WireInstant;

    /// The table the client's directory suite reads too.
    const CASES: &str = include_str!("../../tests/fixtures/session/activity.json");

    /// One case: a published reading, when it was renewed, the reader's clock and what it shows.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ActivityCase {
        note: String,
        activity: SessionActivity,
        activity_renewed_at: WireInstant,
        now_ms: i64,
        expected: SessionActivity,
    }

    #[test]
    fn a_stale_reading_ages_into_idle_as_the_client_ages_it() {
        let cases: Vec<ActivityCase> = serde_json::from_str(CASES).expect("the cases read");
        for case in cases {
            assert_eq!(
                session_activity_as_of(case.activity, &case.activity_renewed_at, case.now_ms),
                case.expected,
                "{}",
                case.note
            );
        }
    }
}
