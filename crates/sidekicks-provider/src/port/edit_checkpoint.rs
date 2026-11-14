//! The copy kept before an agent's edit tool writes a file, as a driver reaches it from the hook
//! that holds the call: the file as it was, kept under the checkpoint of the prompt that started
//! the turn, so an undo can put it back.

use std::path::PathBuf;

use futures::future::BoxFuture;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::session::id::SessionId;

/// An edit an agent's file tool is about to make, as the hook that holds it names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditCheckpointRequest {
    /// The session whose agent called the tool.
    pub session_id: SessionId,
    /// The file the provider's tool input names, resolved by the driver to an absolute path.
    pub path: PathBuf,
    /// The provider's tool call that makes the edit, which names it where its copy failed.
    pub tool_call_id: Option<ToolCallId>,
}

/// The keeping of each file an agent's edit tool is about to write.
pub trait EditCheckpoint: Send + Sync {
    /// Keeps the file `request` names as it stands, called before the hook that holds the edit is
    /// answered, and answers once the copy, or the record that it failed, is written. It never
    /// fails, so the hook is answered either way.
    fn keep_before_edit(&self, request: EditCheckpointRequest) -> BoxFuture<'_, ()>;
}
