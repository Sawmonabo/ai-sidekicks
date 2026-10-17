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
use crate::free_form_string::FilesystemPath;
use crate::method::methods;
use crate::session::event_cursor::EventCursor;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::id::ClientUuid;
use crate::wire::instant::WireInstant;
use crate::wire::integer::SafeInt;
use crate::wire::text::{FreeFormText, NonEmptyText, branded_text};

/// The longest snapshot id the daemon accepts, in code points.
pub const SNAPSHOT_ID_MAX_LEN: usize = 256;

branded_text! {
    /// The daemon-minted id of one of a session's snapshots. Opaque to every client.
    pub struct SnapshotId(1..=SNAPSHOT_ID_MAX_LEN);
}

/// Asks for a session's snapshots. A chat session has none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
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
#[serde(rename_all = "camelCase")]
pub enum SessionRestoreScope {
    /// The conversation and the files.
    ConversationAndFiles,
    /// The conversation alone.
    Conversation,
    /// The files alone.
    Files,
}

/// One part an undo puts back on its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SessionRestorePart {
    /// The conversation.
    Conversation,
    /// The files.
    Files,
}

/// What a finished undo put back: a scope, or nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
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
    /// Whether the scope holds the conversation.
    pub const fn has_conversation(self) -> bool {
        matches!(self, Self::ConversationAndFiles | Self::Conversation)
    }

    /// Whether the scope holds the files.
    pub const fn has_files(self) -> bool {
        matches!(self, Self::ConversationAndFiles | Self::Files)
    }
}

impl From<SessionRestoreScope> for SessionRestoredScope {
    fn from(scope: SessionRestoreScope) -> Self {
        match scope {
            SessionRestoreScope::ConversationAndFiles => Self::ConversationAndFiles,
            SessionRestoreScope::Conversation => Self::Conversation,
            SessionRestoreScope::Files => Self::Files,
        }
    }
}

/// Why a file is skipped rather than put back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
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
    pub path: FilesystemPath,
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
    pub paths: Vec<FilesystemPath>,
}

/// Asks what an undo would do, and changes nothing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
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
    pub ignored_folders: Vec<FilesystemPath>,
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
    "if" = { "properties": { "resend": true }, "required": ["resend"] },
    "then" = { "properties": { "scope": { "const": "conversationAndFiles" } } },
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

/// Holds a finished undo to its account: `files` is present exactly when the files went back,
/// and every asked-for part that did not go back carries the daemon's reason.
fn require_every_part_accounted(
    requested: SessionRestoreScope,
    restored: SessionRestoredScope,
    files: Option<&SessionRestoreFileOutcome>,
    failures: Option<&SessionRestoreFailures>,
) -> garde::Result {
    if files.is_some() != restored.has_files() {
        return Err(garde::Error::new(
            "the files outcome is present exactly when the files went back",
        ));
    }
    let requested = SessionRestoredScope::from(requested);
    let is_conversation_accounted = !requested.has_conversation()
        || restored.has_conversation()
        || failures.is_some_and(|failures| failures.conversation.is_some());
    let is_files_accounted = !requested.has_files()
        || restored.has_files()
        || failures.is_some_and(|failures| failures.files.is_some());
    if is_conversation_accounted && is_files_accounted {
        Ok(())
    } else {
        Err(garde::Error::new(
            "every asked-for part that did not go back carries the daemon's reason",
        ))
    }
}

/// What an undo, or an edit and resend, reports, split on `outcome`: a finished undo with what
/// was asked, what went back and the daemon's reason for every asked-for part that did not, or an
/// edit and resend whose undo applied and whose send failed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
#[garde(custom(|result: &Self, (): &()| result.accounts_for_every_part()))]
pub enum SessionRestoreOutcome {
    /// A finished undo. `files` is present exactly when the files went back.
    #[schemars(extend("allOf" = [
        {
            "if": { "properties": { "restored": { "enum": ["conversationAndFiles", "files"] } } },
            "then": { "properties": { "files": true }, "required": ["files"] },
            "else": { "not": { "required": ["files"] } },
        },
        {
            "if": {
                "properties": {
                    "requested": { "enum": ["conversationAndFiles", "conversation"] },
                    "restored": { "enum": ["files", "nothing"] },
                },
            },
            "then": {
                "required": ["failures"],
                "properties": {
                    "failures": {
                        "type": "object",
                        "properties": { "conversation": true },
                        "required": ["conversation"],
                    },
                },
            },
        },
        {
            "if": {
                "properties": {
                    "requested": { "enum": ["conversationAndFiles", "files"] },
                    "restored": { "enum": ["conversation", "nothing"] },
                },
            },
            "then": {
                "required": ["failures"],
                "properties": {
                    "failures": {
                        "type": "object",
                        "properties": { "files": true },
                        "required": ["files"],
                    },
                },
            },
        },
    ]))]
    RestoreFinished {
        /// What was asked.
        requested: SessionRestoreScope,
        /// What went back.
        restored: SessionRestoredScope,
        /// What the files part did, present exactly when the files went back.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SessionRestoreFileOutcome")]
        files: Option<SessionRestoreFileOutcome>,
        /// The daemon's reason for each asked-for part that did not go back.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "SessionRestoreFailures")]
        failures: Option<SessionRestoreFailures>,
    },
    /// An edit and resend whose undo applied and whose send failed.
    ResendUnapplied {
        /// The send's reason.
        reason: NonEmptyText,
    },
}

impl SessionRestoreOutcome {
    /// Holds a finished undo to its account; a failed resend carries only its reason.
    fn accounts_for_every_part(&self) -> garde::Result {
        match self {
            Self::RestoreFinished {
                requested,
                restored,
                files,
                failures,
            } => require_every_part_accounted(
                *requested,
                *restored,
                files.as_ref(),
                failures.as_ref(),
            ),
            Self::ResendUnapplied { .. } => Ok(()),
        }
    }
}

/// The payload of `session.restore.completed`: one stored record per undo, carrying its result. The
/// conversation cut is also recorded by the run's own rolled-back event.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionRestoreCompletedPayload {
    /// The session.
    pub session_id: SessionId,
    /// The point the undo went back to.
    pub target: SessionRestoreTarget,
    /// What it reported.
    #[garde(dive)]
    pub result: SessionRestoreOutcome,
}

methods! {
    /// The undo methods, each with its types.
    pub const SESSION_RESTORE_METHOD_DESCRIPTORS = [
        /// Says what an undo would do, changing nothing.
        SessionRestorePreview = query "session.restore.preview" {
            mutating: false,
            params: SessionRestorePreviewRequest,
            result: SessionRestorePreviewResponse,
            refusals: [SessionNotFound, SessionEventCursorUnresolvable],
        },
        /// Undoes to a point, with an optional edit and resend.
        SessionRestore = mutation "session.restore" {
            mutating: true,
            params: SessionRestoreRequest,
            result: SessionRestoreOutcome,
            refusals: [SessionNotFound, SessionEventCursorUnresolvable],
        },
        /// Lists a session's snapshots.
        SessionSnapshotList = query "session.snapshot.list" {
            mutating: false,
            params: SessionSnapshotListRequest,
            result: SessionSnapshotListResponse,
            refusals: [SessionNotFound],
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
        Definition::read::<SessionRestoreOutcome>().checked(),
        Definition::read::<SessionRestoreCompletedPayload>().checked(),
    ],
    constants: &[],
    method_tables: &[&SESSION_RESTORE_METHOD_DESCRIPTORS],
};
