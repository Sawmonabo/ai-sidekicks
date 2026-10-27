//! A session's inbox address in one place, answered by the driver of the provider whose sessions
//! must answer that inbox, so no code outside that driver names the provider's socket rules.

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::session::id::SessionId;

/// The inbox addresses the daemon holds, per place, in each place's own form, so the provider's
/// sessions there answer a message sent from them.
pub trait SessionInboxAddresser: Send + Sync {
    /// `session_id`'s inbox in `place` (`None`: the computer's own system on macOS or Linux);
    /// answered for every place, a place the daemon's start did not list included.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "session.read composes each session's addresses from it"
        )
    )]
    fn session_inbox_address(
        &self,
        session_id: &SessionId,
        place: Option<&Place>,
    ) -> FilesystemPath;

    /// The daemon's own inbox in `place`, the one it sends each message from there.
    #[expect(
        dead_code,
        reason = "the daemon's start binds its own inbox in each place at this address"
    )]
    fn daemon_inbox_address(&self, place: Option<&Place>) -> FilesystemPath;
}
