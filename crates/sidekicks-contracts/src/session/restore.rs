//! Undo: the dry run a person reads before anything moves, the undo itself (with edit and resend as
//! the same call), the event every undo settles with, and the list of a session's snapshots.
//!
//! An undo goes back to a stable point: one of the person's own messages, named by its cursor in
//! the session's history, or one of the session's snapshots. The conversation is cut with the
//! provider's own verb and the files are put back from the daemon's own checkpoints, so a dry run
//! and an undo name the same three choices: the conversation and the files, the conversation alone,
//! or the files alone. An undo can land in part; `restored: "nothing"` means both are as they were.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::artifacts::attachment_reference::AttachmentReferenceList;
use crate::free_form_string::FILE_PATH_MAX_LEN;
use crate::internal::branded::branded_text_id;
use crate::method::methods;
use crate::session::draft::ClientUuid;
use crate::session::event_cursor::EventCursor;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::{FreeFormText, NonEmptyText, Text};

/// The longest snapshot id the daemon accepts, in code points.
pub const SNAPSHOT_ID_MAX_LEN: usize = 256;

/// The event an undo settles with, whatever it managed to do.
pub const SESSION_RESTORE_FINISHED_EVENT: &str = "session.restore_finished";

branded_text_id! {
    /// The daemon-minted id of one of a session's snapshots. Opaque to every client.
    SnapshotId, SNAPSHOT_ID_MAX_LEN
}

/// A path an undo names, held to the longest path the wire carries.
type RestorePath = Text<1, FILE_PATH_MAX_LEN>;

/// Asks for a session's snapshots. A chat session has none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSnapshotListRequest {
    /// The session.
    pub session_id: SessionId,
}

/// One snapshot: its id, the name the inspector shows (`Before <turn>`), and when it was taken.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionSnapshotSummary {
    /// The snapshot.
    pub snapshot_id: SnapshotId,
    /// The name the inspector shows.
    pub name: NonEmptyText,
    /// When it was taken.
    #[garde(dive)]
    pub created_at: WireInstant,
}

/// A session's snapshots.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionSnapshotListResponse {
    /// The snapshots.
    #[garde(dive)]
    pub snapshots: Vec<SessionSnapshotSummary>,
}

/// The point an undo goes back to: before one of the person's messages, or a snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SessionRestoreTarget {
    /// Before one of the person's messages.
    Message {
        /// The message's cursor in the session's history.
        anchor_cursor: EventCursor,
    },
    /// A snapshot.
    Snapshot {
        /// The snapshot.
        snapshot_id: SnapshotId,
    },
}

/// What an undo is asked to put back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SessionRestoreScope {
    /// The conversation and the files.
    ConversationAndFiles,
    /// The conversation alone.
    Conversation,
    /// The files alone.
    Files,
}

impl SessionRestoreScope {
    /// Whether the scope puts the conversation back.
    pub const fn has_conversation(self) -> bool {
        matches!(self, Self::ConversationAndFiles | Self::Conversation)
    }

    /// Whether the scope puts the files back.
    pub const fn has_files(self) -> bool {
        matches!(self, Self::ConversationAndFiles | Self::Files)
    }
}

/// One part an undo puts back on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SessionRestorePart {
    /// The conversation.
    Conversation,
    /// The files.
    Files,
}

/// What a finished undo put back: a scope, or nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SessionRestoredScope {
    /// The conversation and the files.
    ConversationAndFiles,
    /// The conversation alone.
    Conversation,
    /// The files alone.
    Files,
    /// Neither: both are as they were.
    Nothing,
}

impl SessionRestoredScope {
    /// Whether the conversation went back.
    pub const fn has_conversation(self) -> bool {
        matches!(self, Self::ConversationAndFiles | Self::Conversation)
    }

    /// Whether the files went back.
    pub const fn has_files(self) -> bool {
        matches!(self, Self::ConversationAndFiles | Self::Files)
    }
}

/// Why a file is skipped rather than put back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SessionRestoreSkipReason {
    /// The path is a symbolic link.
    SymbolicLink,
    /// The path is a hard link.
    HardLink,
    /// The path is not a plain file.
    NotARegularFile,
    /// The folder that held it moved.
    DirectoryMoved,
    /// A file over 10 MiB a command changed, on a disk that cannot clone it, so no copy was kept.
    TooLarge,
    /// A command that moved the branch changed it; putting it back would turn the branch's commits
    /// into uncommitted reversals.
    BranchMovedByCommand,
}

/// A file an undo leaves as it is, and why. A skip is always named and never stops the undo.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRestoreSkippedFile {
    /// The file.
    pub path: RestorePath,
    /// Why it is skipped.
    pub reason: SessionRestoreSkipReason,
}

/// Paths another session working in the same folder also changed since the point.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRestoreAlsoChanged {
    /// The other session.
    pub session_id: SessionId,
    /// The paths it changed.
    pub paths: Vec<RestorePath>,
}

/// Asks what an undo would do, and changes nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRestorePreviewRequest {
    /// The session.
    pub session_id: SessionId,
    /// The point to go back to.
    pub target: SessionRestoreTarget,
    /// What to put back.
    pub scope: SessionRestoreScope,
}

/// What an undo would do. `file_count` and `line_count` are the files it would put back and the
/// lines across them; `affected_child_count` and `running_commands` count the agents and commands
/// started after the point that are still running, which the undo stops first. `ignored_folders`
/// and `commands_ran_after_point` feed the notice shown whenever a command ran after the point;
/// `also_changed_by` names the paths another session changed since the point.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRestorePreviewResponse {
    /// The files it would put back.
    pub file_count: SafeInt<0>,
    /// The lines across them.
    pub line_count: SafeInt<0>,
    /// The files it would skip.
    pub skipped: Vec<SessionRestoreSkippedFile>,
    /// The agents started after the point that are still running.
    pub affected_child_count: SafeInt<0>,
    /// The commands started after the point that are still running.
    pub running_commands: SafeInt<0>,
    /// The folders the project ignores, never put back.
    pub ignored_folders: Vec<RestorePath>,
    /// Whether a command ran after the point.
    pub commands_ran_after_point: bool,
    /// The paths other sessions changed since the point.
    pub also_changed_by: Vec<SessionRestoreAlsoChanged>,
}

/// The edited message an edit and resend sends once the undo has applied, with its files.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRestoreResend {
    /// The edited message.
    pub content: FreeFormText<{ usize::MAX }>,
    /// Its files, where it has any.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AttachmentReferenceList")]
    pub attachments: Option<AttachmentReferenceList>,
}

/// Undoes to a point, and with `resend` sends an edited message from there in the same call.
/// `client_idempotency_key` is unique within the session, so a retried undo never cuts twice.
/// `include_also_changed` puts back the paths another session also changed since the point.
/// `resend` goes only with the conversation and the files together; a narrower scope is refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend(
    "if" = { "required": ["resend"] },
    "then" = { "properties": { "scope": { "const": "conversation-and-files" } } },
))]
pub struct SessionRestoreRequest {
    /// The session.
    pub session_id: SessionId,
    /// The point to go back to.
    pub target: SessionRestoreTarget,
    /// What to put back.
    pub scope: SessionRestoreScope,
    /// The client's key for this undo.
    pub client_idempotency_key: ClientUuid,
    /// Whether to put back the paths another session also changed.
    pub include_also_changed: bool,
    /// The edited message to send once the undo has applied.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionRestoreResend")]
    #[garde(custom(|resend: &Option<SessionRestoreResend>, (): &()| {
        if resend.is_none() || self.scope == SessionRestoreScope::ConversationAndFiles {
            Ok(())
        } else {
            Err(garde::Error::new(
                "an edit and resend puts back the conversation and the files together",
            ))
        }
    }))]
    pub resend: Option<SessionRestoreResend>,
}

/// Why one asked-for part did not go back, in the daemon's words.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRestoreFailure {
    /// The daemon's reason.
    pub reason: NonEmptyText,
}

/// The daemon's reason for each asked-for part that did not go back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRestoreFailures {
    /// Why the conversation did not go back.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionRestoreFailure")]
    pub conversation: Option<SessionRestoreFailure>,
    /// Why the files did not go back.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionRestoreFailure")]
    pub files: Option<SessionRestoreFailure>,
}

/// What the files part of an undo actually did: the files it put back, the lines across them, and
/// every file it skipped with the reason. These are the undo's own figures, not the dry run's,
/// because the folder can change between the two.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionRestoreFileOutcome {
    /// The files put back.
    pub restored_file_count: SafeInt<0>,
    /// The lines across them.
    pub restored_line_count: SafeInt<0>,
    /// The files skipped.
    pub skipped: Vec<SessionRestoreSkippedFile>,
}

/// The `restore-finished` outcome word.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[schemars(inline)]
pub enum RestoreFinishedOutcome {
    /// The one value.
    #[serde(rename = "restore-finished")]
    RestoreFinished,
}

/// The `resend-unapplied` outcome word.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[schemars(inline)]
pub enum ResendUnappliedOutcome {
    /// The one value.
    #[serde(rename = "resend-unapplied")]
    ResendUnapplied,
}

/// Whether every asked-for part either went back or carries the daemon's reason.
fn is_every_requested_part_accounted(
    requested: SessionRestoreScope,
    restored: SessionRestoredScope,
    failures: Option<&SessionRestoreFailures>,
) -> bool {
    let is_conversation_accounted = !requested.has_conversation()
        || restored.has_conversation()
        || failures.is_some_and(|failures| failures.conversation.is_some());
    let is_files_accounted = !requested.has_files()
        || restored.has_files()
        || failures.is_some_and(|failures| failures.files.is_some());
    is_conversation_accounted && is_files_accounted
}

/// A finished undo: what was asked, what went back, and the daemon's reason for every asked-for
/// part that did not. `files` is present exactly when the files went back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(extend("allOf" = [
    {
        "if": { "properties": { "restored": { "enum": ["conversation-and-files", "files"] } } },
        "then": { "required": ["files"] },
        "else": { "not": { "required": ["files"] } },
    },
    {
        "if": {
            "properties": {
                "requested": { "enum": ["conversation-and-files", "conversation"] },
                "restored": { "enum": ["files", "nothing"] },
            },
        },
        "then": {
            "required": ["failures"],
            "properties": { "failures": { "type": "object", "required": ["conversation"] } },
        },
    },
    {
        "if": {
            "properties": {
                "requested": { "enum": ["conversation-and-files", "files"] },
                "restored": { "enum": ["conversation", "nothing"] },
            },
        },
        "then": {
            "required": ["failures"],
            "properties": { "failures": { "type": "object", "required": ["files"] } },
        },
    },
]))]
pub struct SessionRestoreFinished {
    /// Always `restore-finished`.
    pub outcome: RestoreFinishedOutcome,
    /// What was asked.
    pub requested: SessionRestoreScope,
    /// What went back.
    pub restored: SessionRestoredScope,
    /// What the files part did, present exactly when the files went back.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionRestoreFileOutcome")]
    #[garde(custom(|files: &Option<SessionRestoreFileOutcome>, (): &()| {
        if files.is_some() == self.restored.has_files() {
            Ok(())
        } else {
            Err(garde::Error::new("the files outcome is present exactly when the files went back"))
        }
    }))]
    pub files: Option<SessionRestoreFileOutcome>,
    /// The daemon's reason for each asked-for part that did not go back.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionRestoreFailures")]
    #[garde(custom(|failures: &Option<SessionRestoreFailures>, (): &()| {
        if is_every_requested_part_accounted(self.requested, self.restored, failures.as_ref()) {
            Ok(())
        } else {
            Err(garde::Error::new(
                "every asked-for part that did not go back carries the daemon's reason",
            ))
        }
    }))]
    pub failures: Option<SessionRestoreFailures>,
}

/// An edit and resend whose undo applied and whose send failed, with the send's reason.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionResendUnapplied {
    /// Always `resend-unapplied`.
    pub outcome: ResendUnappliedOutcome,
    /// The send's reason.
    pub reason: NonEmptyText,
}

/// What an undo, or an edit and resend, reports.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum SessionRestoreResult {
    /// A finished undo.
    Finished(#[garde(dive)] SessionRestoreFinished),
    /// An edit and resend whose send failed.
    ResendUnapplied(#[garde(skip)] SessionResendUnapplied),
}

/// The payload of `session.restore_finished`: one stored record per undo, carrying its result. The
/// conversation cut is also recorded by the run's own rolled-back event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionRestoreFinishedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The point the undo went back to.
    pub target: SessionRestoreTarget,
    /// What it reported.
    #[garde(dive)]
    pub result: SessionRestoreResult,
}

methods! {
    /// The undo methods, each with its types.
    pub const SESSION_RESTORE_METHOD_DESCRIPTORS = [
        /// Says what an undo would do, changing nothing.
        SessionRestorePreview = query "session.restorePreview" {
            mutating: false,
            params: SessionRestorePreviewRequest,
            result: SessionRestorePreviewResponse,
            refusals: [],
        },
        /// Undoes to a point, with an optional edit and resend.
        SessionRestore = mutation "session.restore" {
            mutating: true,
            params: SessionRestoreRequest,
            result: SessionRestoreResult,
            refusals: [],
        },
        /// Lists a session's snapshots.
        SessionSnapshotList = query "session.snapshotList" {
            mutating: false,
            params: SessionSnapshotListRequest,
            result: SessionSnapshotListResponse,
            refusals: [],
        },
    ];
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/restore",
    doc: "Undo: the dry run, the undo itself with edit and resend, the event every undo settles \
          with, and the list of a session's snapshots.",
    definitions: &[
        Definition::read::<SnapshotId>(),
        Definition::read::<SessionSnapshotListRequest>().checked(),
        Definition::read::<SessionSnapshotSummary>(),
        Definition::read::<SessionSnapshotListResponse>().checked(),
        Definition::read::<SessionRestoreTarget>(),
        Definition::read::<SessionRestoreScope>(),
        Definition::read::<SessionRestorePart>(),
        Definition::read::<SessionRestoredScope>(),
        Definition::read::<SessionRestoreSkipReason>(),
        Definition::read::<SessionRestoreSkippedFile>(),
        Definition::read::<SessionRestoreAlsoChanged>(),
        Definition::read::<SessionRestorePreviewRequest>().checked(),
        Definition::read::<SessionRestorePreviewResponse>().checked(),
        Definition::read::<SessionRestoreResend>(),
        Definition::read::<SessionRestoreRequest>().checked(),
        Definition::read::<SessionRestoreFailure>(),
        Definition::read::<SessionRestoreFailures>(),
        Definition::read::<SessionRestoreFileOutcome>(),
        Definition::read::<SessionRestoreFinished>(),
        Definition::read::<SessionResendUnapplied>(),
        Definition::read::<SessionRestoreResult>().checked(),
        Definition::read::<SessionRestoreFinishedPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[&SESSION_RESTORE_METHOD_DESCRIPTORS],
};
