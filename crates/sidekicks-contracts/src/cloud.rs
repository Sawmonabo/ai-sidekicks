//! A session's work in its provider's own cloud. The daemon only calls the provider's cloud verbs
//! and never runs the remote work, so the work's state is only what its provider reported. Cloud
//! work is one of two kinds, with the provider as data: a task with attempts, which reports
//! `pending`, `ready`, `applied` or `error`, or a cloud session, which reads no status and stays
//! `submitted`. The shape is split by kind so neither carries the other's states.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::free_form_string::FilesystemPath;
use crate::jsonrpc::streaming::SubscribeAckResponse;
use crate::method::methods;
use crate::provider::name::ProviderName;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::web_address::HttpsAddress;
use crate::wire::integer::BoundedInt;
use crate::wire::literal;
use crate::wire::text::{FreeFormText, NonBlankText, NonEmptyText, branded_text};
use crate::wire::{NullableSchema, nullable};

ts_constants! {
    /// The longest cloud task id the daemon accepts.
    pub const CLOUD_TASK_ID_MAX_LEN: usize = 256;
    /// The longest cloud environment label the daemon accepts.
    pub const CLOUD_ENVIRONMENT_LABEL_MAX_LEN: usize = 256;
    /// The most attempts one cloud task runs: its provider's own bound.
    pub const CLOUD_TASK_ATTEMPTS_MAX: i64 = 4;
    /// Every reason the cloud can be unavailable, for the session menu that shows why.
    CLOUD_UNAVAILABLE_REASONS = CloudUnavailableReason::VARIANTS;
}

branded_text! {
    /// The id the provider gave its cloud work: a task's id, or a cloud session's id.
    pub struct CloudTaskId(1..=CLOUD_TASK_ID_MAX_LEN);
}

/// One attempt of a cloud task, counted from 1.
pub type CloudTaskAttempt = BoundedInt<1, CLOUD_TASK_ATTEMPTS_MAX>;

/// The label of a cloud environment, as the account's tasks name it or as typed.
pub type CloudEnvironmentLabel = FreeFormText<CLOUD_ENVIRONMENT_LABEL_MAX_LEN>;

/// Why sending to the cloud was refused: the account lacks the provider's sign-in or
/// subscription, or the project has no GitHub remote.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "snake_case")]
pub enum CloudUnavailableReason {
    /// The provider's cloud needs a sign-in the account lacks.
    ProviderSignInRequired,
    /// The provider's cloud needs a subscription the account lacks.
    ProviderSubscriptionRequired,
    /// The project has no GitHub remote.
    GithubRemoteRequired,
}

/// The `cloud.unavailable` refusal's details: why, and the session's provider, so the screen draws
/// that provider's own sentence and remedy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudUnavailableDetails {
    /// Why.
    pub reason: CloudUnavailableReason,
    /// The session's provider.
    pub provider: ProviderName,
}

/// What the provider reported when a task's attempt was applied to the session's folder: all of
/// it, part of it with the paths it skipped and the paths in conflict, or an error in the
/// provider's own words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "outcome",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CloudBringBack {
    /// All of it was applied.
    Applied {},
    /// Part of it was applied.
    Partial {
        /// The paths it skipped.
        skipped_paths: Vec<FilesystemPath>,
        /// The paths in conflict.
        conflicting_paths: Vec<FilesystemPath>,
    },
    /// The apply failed.
    Error {
        /// The provider's message.
        message: NonEmptyText,
    },
}

literal! {
    /// The kind of a cloud task with attempts.
    pub enum CloudTaskKind = "task";
    /// The kind of a cloud session.
    pub enum CloudSessionKind = "session";
    /// The state of a cloud task its provider reported as failed.
    pub enum CloudTaskErrorState = "error";
    /// The one state of a cloud session.
    pub enum CloudSessionState = "submitted";
}

/// A state of a cloud task its provider reported without an error.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CloudTaskState {
    /// Running in the cloud.
    Pending,
    /// Done, waiting to be brought back.
    Ready,
    /// Brought back.
    Applied,
}

/// Declares one arm of a cloud task with the members every arm repeats.
macro_rules! cloud_task {
    ($(#[doc = $doc:literal])+ $name:ident { $($extra:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        pub struct $name {
            /// Always `task`.
            pub kind: CloudTaskKind,
            /// The task.
            pub task_id: CloudTaskId,
            /// The session that sent it.
            pub session_id: SessionId,
            /// The provider whose cloud runs it.
            pub provider: ProviderName,
            /// The environment it runs in.
            pub environment: CloudEnvironmentLabel,
            /// How many attempts it runs.
            pub attempts: CloudTaskAttempt,
            /// The last bring-back of this task, or `null` before the first.
            #[serde(deserialize_with = "nullable")]
            #[schemars(with = "NullableSchema<CloudBringBack>")]
            pub bring_back: Option<CloudBringBack>,
            $($extra)*
        }
    };
}

cloud_task! {
    /// A cloud task its provider reported without an error.
    CloudTaskReported {
        /// Its state.
        pub state: CloudTaskState,
    }
}

cloud_task! {
    /// A cloud task its provider reported as failed.
    CloudTaskFailed {
        /// Always `error`.
        pub state: CloudTaskErrorState,
        /// The provider's own message.
        pub error_message: NonEmptyText,
    }
}

/// A cloud session: its state is `submitted` for its whole life, and `url` is its address on the
/// provider's site.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct CloudSession {
    /// Always `session`.
    pub kind: CloudSessionKind,
    /// The cloud session.
    pub task_id: CloudTaskId,
    /// The session that sent it.
    pub session_id: SessionId,
    /// The provider whose cloud holds it.
    pub provider: ProviderName,
    /// Always `submitted`.
    pub state: CloudSessionState,
    /// Its address on the provider's site.
    pub url: HttpsAddress<{ usize::MAX }>,
}

/// One piece of a session's cloud work, with only the state its provider reported.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
#[garde(allow_unvalidated)]
pub enum CloudWork {
    /// A task its provider reported without an error.
    Task(CloudTaskReported),
    /// A task its provider reported as failed.
    FailedTask(CloudTaskFailed),
    /// A cloud session.
    Session(CloudSession),
}

/// `cloud.taskStart`: sends one message to the session's provider's cloud instead of to the
/// agent. `environment` and `attempts` belong to a task with attempts: the environment's label and
/// how many attempts to run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct CloudTaskStartRequest {
    /// The session.
    pub session_id: SessionId,
    /// The message.
    pub prompt: NonBlankText,
    /// The environment's label.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "CloudEnvironmentLabel")]
    pub environment: Option<CloudEnvironmentLabel>,
    /// How many attempts to run.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "CloudTaskAttempt")]
    pub attempts: Option<CloudTaskAttempt>,
}

/// The new work's id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct CloudTaskStartResponse {
    /// The new work.
    pub task_id: CloudTaskId,
}

/// `cloud.taskList`: the session whose cloud work the subscription follows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct CloudTaskListRequest {
    /// The session.
    pub session_id: SessionId,
}

/// The session's whole set of cloud work, sent first on subscribing and again on each change, so a
/// subscriber never composes changes into a set of its own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct CloudTaskListFrame {
    /// The session.
    pub session_id: SessionId,
    /// Its cloud work.
    pub tasks: Vec<CloudWork>,
}

/// `cloud.taskRead`: the cloud work to read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct CloudTaskReadRequest {
    /// The work.
    pub task_id: CloudTaskId,
}

/// `cloud.taskDiffRead` and `cloud.taskApply`: one task's attempt, `attempt` picking one of a
/// task's several; for `cloud.taskApply` on a cloud session, the session to pull back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct CloudTaskAttemptRequest {
    /// The work.
    pub task_id: CloudTaskId,
    /// The attempt.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "CloudTaskAttempt")]
    pub attempt: Option<CloudTaskAttempt>,
}

/// The attempt's diff as the provider prints it, for the review pane to show read-only.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct CloudTaskDiffReadResponse {
    /// The task.
    pub task_id: CloudTaskId,
    /// The attempt.
    pub attempt: CloudTaskAttempt,
    /// Its diff.
    pub diff: String,
}

/// What bringing cloud work back did: for a task, what the apply reported; for a cloud session,
/// the new session the returned work opened as.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum CloudTaskApplyResponse {
    /// A task's attempt was applied to the session's folder after a file checkpoint.
    Task {
        /// What the apply reported.
        bring_back: CloudBringBack,
    },
    /// A cloud session was pulled into a new worktree and imported as a new session.
    Session {
        /// The new session.
        session_id: SessionId,
    },
}

/// The `cloud.task_updated` payload: cloud work was sent, its provider reported a new state, or it
/// was brought back. It carries the whole work as it now stands, so the session's record of its
/// cloud work is the latest of these per id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudTaskUpdatedPayload {
    /// The work.
    pub task: CloudWork,
}

methods! {
    /// The `cloud.*` methods.
    pub const CLOUD_METHOD_DESCRIPTORS = [
        /// Sends one message to the session's provider's cloud.
        CloudTaskStart = mutation "cloud.taskStart" {
            mutating: true,
            params: CloudTaskStartRequest,
            result: CloudTaskStartResponse,
            refusals: [SessionNotFound, CloudUnavailable],
        },
        /// Follows the session's cloud work.
        CloudTaskList = subscription "cloud.taskList" {
            mutating: false,
            params: CloudTaskListRequest,
            result: SubscribeAckResponse,
            emission: CloudTaskListFrame,
            refusals: [SessionNotFound],
        },
        /// Reads one piece of cloud work.
        CloudTaskRead = query "cloud.taskRead" {
            mutating: false,
            params: CloudTaskReadRequest,
            result: CloudWork,
            refusals: [],
        },
        /// Reads a ready task's diff.
        CloudTaskDiffRead = query "cloud.taskDiffRead" {
            mutating: false,
            params: CloudTaskAttemptRequest,
            result: CloudTaskDiffReadResponse,
            refusals: [],
        },
        /// Brings cloud work back.
        CloudTaskApply = mutation "cloud.taskApply" {
            mutating: true,
            params: CloudTaskAttemptRequest,
            result: CloudTaskApplyResponse,
            refusals: [],
        },
    ];
}

/// The TypeScript module of a session's cloud work.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "cloud",
    doc: "A session's work in its provider's own cloud: a task with attempts, or a cloud session.",
    definitions: &[
        Definition::read::<CloudTaskId>().checked(),
        Definition::read::<CloudUnavailableReason>(),
        Definition::read::<CloudUnavailableDetails>().checked(),
        Definition::read::<CloudBringBack>().checked(),
        Definition::read::<CloudTaskState>(),
        Definition::read::<CloudWork>().checked(),
        Definition::read::<CloudTaskStartRequest>().checked(),
        Definition::read::<CloudTaskStartResponse>(),
        Definition::read::<CloudTaskListRequest>(),
        Definition::read::<CloudTaskListFrame>(),
        Definition::read::<CloudTaskReadRequest>(),
        Definition::read::<CloudTaskAttemptRequest>(),
        Definition::read::<CloudTaskDiffReadResponse>(),
        Definition::read::<CloudTaskApplyResponse>(),
        Definition::read::<CloudTaskUpdatedPayload>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&CLOUD_METHOD_DESCRIPTORS],
};
