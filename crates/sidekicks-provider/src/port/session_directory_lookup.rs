//! How a driver's hook finds another session of the person's from what a tool call names: the
//! daemon's session directory, answering a name or an id.

use std::error::Error;

use futures::future::BoxFuture;

/// One session of the daemon's directory a name or an id matched, as a driver's hook reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirectoryMatch {
    /// The id the session tools take for it.
    pub id: String,
    /// Its name.
    pub name: String,
}

/// The daemon's session directory, registered through a `PortRegistration`. Until it is
/// registered a hook reads the provider's own registry alone, so a session the daemon hosts that
/// is not yet in that registry goes unrecognized.
pub trait SessionDirectoryLookup: Send + Sync {
    /// Every session `target` names, by name or by id: a name several sessions share answers
    /// each, and a target no session has answers none. Fails when the read fails.
    fn sessions_named(
        &self,
        target: String,
    ) -> BoxFuture<'_, Result<Vec<DirectoryMatch>, Box<dyn Error + Send + Sync>>>;
}
