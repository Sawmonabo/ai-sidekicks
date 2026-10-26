//! The current user's id on macOS and Linux.

/// The current user's real id, the one a provider names its per-user socket folder with; `None`
/// on native Windows, which has none.
pub fn current_user_id() -> Option<u32> {
    Some(nix::unistd::getuid().as_raw())
}
