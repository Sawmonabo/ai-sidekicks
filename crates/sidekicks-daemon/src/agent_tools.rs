//! The daemon's handlers for the agent tools it serves on its own tool server, each answering one
//! call with its result text for the calling model.

pub(crate) mod session;

use std::error::Error;

use sidekicks_store::database::connection::read_pool::DatabaseReadError;

/// Why an agent tool answered no result.
#[derive(Debug, thiserror::Error)]
pub(crate) enum AgentToolError {
    /// The call is refused, with the text the calling model reads.
    #[error("{0}")]
    Refused(String),
    /// A read the tool needs failed, which is a fault in the daemon.
    #[error(transparent)]
    Failed(Box<dyn Error + Send + Sync>),
}

impl AgentToolError {
    /// The failure of a read the tool needs.
    pub(crate) fn failed(error: impl Error + Send + Sync + 'static) -> Self {
        Self::Failed(Box::new(error))
    }
}

impl From<DatabaseReadError> for AgentToolError {
    fn from(error: DatabaseReadError) -> Self {
        Self::failed(error)
    }
}

impl From<rusqlite::Error> for AgentToolError {
    fn from(error: rusqlite::Error) -> Self {
        Self::failed(error)
    }
}
