//! The current user's id and keychain name on Windows, which has neither.

/// The current user's real id, the one a provider names its per-user socket folder with; `None`
/// on native Windows, which has none.
pub fn current_user_id() -> Option<u32> {
    None
}

/// The current user's login name as a provider files its keychain item under; `None` on native
/// Windows, where no provider keeps its sign-in in a keychain.
pub fn current_user_name() -> Option<String> {
    None
}
