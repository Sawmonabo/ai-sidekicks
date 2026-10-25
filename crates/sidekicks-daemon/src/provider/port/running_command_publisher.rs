//! Where a driver sends a running command's output as it prints, to the subscribers of the
//! session's running-commands stream. Nothing here is stored: the command's whole output lands as
//! its tool call's result.

use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::session::id::SessionId;

/// The running-commands stream's live output intake, registered through a `PortRegistration`. It
/// never blocks or fails back into the provider's stream; output with no subscriber, or arriving
/// before the publisher is registered, is dropped, never stored.
pub(crate) trait CommandOutputPublisher: Send + Sync {
    /// Publishes `data`, a piece of `command_id`'s output in `session_id` as it printed, as the
    /// stream's output frame.
    fn publish_output(&self, session_id: SessionId, command_id: CommandId, data: String);
}
