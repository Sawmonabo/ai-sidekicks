//! The current user's id and name on macOS and Linux.

/// The current user's real id, the one a provider names its per-user socket folder with; `None`
/// on native Windows, which has none.
pub fn current_user_id() -> Option<u32> {
    Some(nix::unistd::getuid().as_raw())
}

/// The current user's login name from the user database, the name a provider files its keychain
/// item under when its environment names none; `None` where the database has no entry for the id
/// or cannot be read, which such a provider answers with a fixed name.
pub fn current_user_name() -> Option<String> {
    nix::unistd::User::from_uid(nix::unistd::getuid())
        .ok()
        .flatten()
        .map(|user| user.name)
}
