//! The sign-out a binding's removal owes its server: owed before the provider's write, so a stop
//! between the write and the sign-out leaves it for the next start, and settled once the removal
//! has answered, signing the server out where no binding still names it.

use futures::future::BoxFuture;
use sidekicks_contracts::mcp::server::McpServerBindingRef;

use crate::errors::McpRefusal;

/// Owes and settles the sign-out a removed binding's server is due.
pub trait McpRemovalSignOut: Send + Sync {
    /// Owes the sign-out of the server `binding` names, before its removal is written, answering
    /// the hold that keeps a settle from clearing it until the removal has answered. Refuses
    /// `provider.unavailable` when the binding's address cannot be read and
    /// `mcp.bindingStoreUnavailable` when the record is not kept, so nothing is written.
    fn owe_sign_out<'a>(
        &'a self,
        binding: &'a McpServerBindingRef,
    ) -> BoxFuture<'a, Result<McpRemovalSignOutHold, McpRefusal>>;

    /// Settles every owed sign-out: signs out each server no binding still names and clears its
    /// record. A failure is logged and keeps the records it reached for the next settle.
    fn settle_owed_sign_outs(&self) -> BoxFuture<'_, ()>;
}

/// What an owed sign-out holds while its removal runs: its release runs when the hold drops, so a
/// removal whose future is dropped mid-write releases it too. Empty where nothing is owed.
#[derive(Default)]
pub struct McpRemovalSignOutHold {
    release: Option<Box<dyn FnOnce() + Send>>,
}

impl McpRemovalSignOutHold {
    /// A hold that runs `release` when it drops.
    pub fn new(release: impl FnOnce() + Send + 'static) -> Self {
        Self {
            release: Some(Box::new(release)),
        }
    }
}

impl Drop for McpRemovalSignOutHold {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            release();
        }
    }
}
