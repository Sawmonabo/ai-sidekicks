//! Where a driver reads the prompts a session's tool servers offer for its `/` list, and follows
//! them as they change: the daemon's tool-server client answers it once it runs.

use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_contracts::provider::driver::commands::{
    ProviderCommandBinding, ProviderCommandEntry,
};
use sidekicks_contracts::session::id::SessionId;

/// The daemon's tool-server client's side of the `/` list: each working server's prompts for a
/// session, registered through a `PortRegistration`. Until it is registered, the list holds no
/// tool-server prompt.
pub(crate) trait ServerPromptPort: Send + Sync {
    /// Each working tool server's prompts for the session, as prompt entries naming a server.
    fn read_prompts(
        &self,
        session_id: SessionId,
        binding: ProviderCommandBinding,
    ) -> BoxFuture<'_, Vec<ProviderCommandEntry>>;

    /// Calls `on_change` when a server's prompts for the session change, until the returned
    /// call stops the watch.
    fn watch_prompts(
        &self,
        session_id: SessionId,
        on_change: Arc<dyn Fn() + Send + Sync>,
    ) -> Box<dyn FnOnce() + Send>;
}
