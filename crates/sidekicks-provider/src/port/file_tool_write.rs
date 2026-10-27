//! Where a driver reports each write its agent's own file tool makes, so a chat keeps one version
//! per write even where the workspace's watch merges two writes into one report: a call opened on a
//! path, then settled with the file's whole bytes as the tool's result gives them, or with no
//! write.

use std::error::Error;
use std::path::PathBuf;

use bytes::Bytes as ByteBuffer;
use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;

/// A file tool's call opened on one path, before it writes. A call that moves a file opens on the
/// path it moves the file to.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the providers' drivers' file tools, which report each write"
    )
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileToolWriteOpened {
    /// The session whose agent called the tool.
    pub session_id: SessionId,
    /// The provider's own id of the call.
    pub call_id: String,
    /// The file the call writes, as the tool names it.
    pub path: PathBuf,
}

/// What a file tool's call left at its path.
#[expect(
    dead_code,
    reason = "the providers' drivers' file tools, which report each write"
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileToolWriteOutcome {
    /// The file's whole bytes after the call, as its result gives them.
    Written(ByteBuffer),
    /// The call wrote nothing: it failed, was refused, or left the file as it was.
    NotWritten,
}

/// A file tool's call settled, by the id it opened under.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the providers' drivers' file tools, which report each write"
    )
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileToolWriteSettled {
    /// The session whose agent called the tool.
    pub session_id: SessionId,
    /// The provider's own id of the call.
    pub call_id: String,
    /// The file the call wrote, as it opened.
    pub path: PathBuf,
    /// What the call left there.
    pub outcome: FileToolWriteOutcome,
}

/// A chat's versions' intake of its agent's file tool writes, registered through a
/// `PortRegistration`. Until it is registered, a chat's versions come from its workspace's watch
/// alone.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the providers' drivers' file tools, which report each write"
    )
)]
pub trait FileToolWritePort: Send + Sync {
    /// Holds the watch's reports of `opened`'s path until the call settles. An error when the call
    /// could not be held.
    fn open_file_tool_write(
        &self,
        opened: FileToolWriteOpened,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Records what `settled` left as its path's next version, in the order the calls opened. An
    /// error when it could not be recorded.
    fn settle_file_tool_write(
        &self,
        settled: FileToolWriteSettled,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}
