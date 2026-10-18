//! Where a session's inbox socket sits in one place: the folder the driver of the provider that
//! messages other sessions names, so no code outside that driver names the provider's folder.

use std::path::PathBuf;

use sidekicks_contracts::place::Place;

/// The folder each session's inbox socket sits in, per place, answered by the messaging
/// provider's driver.
pub(crate) trait SessionInboxFolders: Send + Sync {
    /// The folder in `place` (`None`: the computer's own system), for a place that names its
    /// sockets by path; only a place the daemon's start listed is asked for.
    fn inbox_folder(&self, place: Option<&Place>) -> PathBuf;
}
