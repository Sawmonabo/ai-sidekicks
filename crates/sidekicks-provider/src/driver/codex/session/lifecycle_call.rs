//! The driver's own calls on a Codex session's record, which its task takes in place among the
//! frames, and the readings a compaction's call and a running command's read answer.

use std::sync::Arc;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::controls::methods::SessionMode;
use tokio::sync::oneshot;

use crate::driver::codex::run::turn_end_waiters::CodexRecordExit;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::session_control::{AskSideQuestionParams, UpdatePermissionLevelParams};

/// A call of the driver's own on a session's record, each answering on its own `reply`; a dropped
/// `reply` means the session's task let the record go first.
pub(crate) enum CodexLifecycleCall {
    /// Marks the session's close intended, so a turn that ends now ends as closed, and answers the
    /// runs the record still holds.
    BeginClose {
        /// Where the runs go, each once.
        reply: oneshot::Sender<Vec<RunId>>,
    },
    /// Lets the record go: its routes and waits first, then its conversation.
    LetGo {
        /// How the record stopped being its session's.
        exit: CodexRecordExit,
        /// Answered once it is gone.
        reply: oneshot::Sender<()>,
    },
    /// Moves the conversation to another permission level from its next turn.
    MoveLevel {
        /// The posture it moves to.
        params: UpdatePermissionLevelParams,
        /// Where the move's failure goes.
        reply: oneshot::Sender<Result<(), CodexError>>,
    },
    /// Moves the conversation between Build and Plan from its next turn.
    MoveMode {
        /// The mode.
        mode: SessionMode,
        /// Where the move's failure goes.
        reply: oneshot::Sender<Result<(), CodexError>>,
    },
    /// Asks a side question on a read-only copy of the conversation.
    AskSideQuestion {
        /// The question.
        params: Box<AskSideQuestionParams>,
        /// Where the ask's failure goes.
        reply: oneshot::Sender<Result<(), CodexError>>,
    },
    /// Reads the conversation a compaction runs on.
    ReadCompaction {
        /// Where the reading goes.
        reply: oneshot::Sender<CodexCompactionReading>,
    },
    /// Reads where the command item `item_id` runs, while its row is open.
    ReadRunningCommand {
        /// The command's item.
        item_id: String,
        /// Where the reading goes, `None` once the command's item ended.
        reply: oneshot::Sender<Option<CodexRunningCommandReading>>,
    },
}

/// Where a running command runs, as the session's task read it, for a stop of its background
/// terminal.
pub(crate) struct CodexRunningCommandReading {
    /// The connection, or why the service has none.
    pub(crate) connection: Result<Arc<CodexAppServerConnection>, CodexError>,
    /// The conversation it runs in.
    pub(crate) thread_id: String,
    /// Codex's own id for its process, `None` where its item named none.
    pub(crate) terminal_process_id: Option<String>,
}

/// The conversation a compaction runs on, as the session's task read it.
pub(crate) struct CodexCompactionReading {
    /// The connection, or why the service has none.
    pub(crate) connection: Result<Arc<CodexAppServerConnection>, CodexError>,
    /// The account the conversation runs on.
    pub(crate) provider_account_id: ProviderAccountId,
    /// The conversation.
    pub(crate) thread_id: String,
    /// The compaction wait's key for it.
    pub(crate) wait_key: String,
}
