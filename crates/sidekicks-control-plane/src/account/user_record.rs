//! The account's user record as the passkey routes read it: the user a signed-in caller is, or
//! the one a passkey belongs to, with the user handle their passkeys were made under. A row that
//! does not read as these types fails the read.

use serde::Deserialize;
use sidekicks_contracts::session::id::UserId;
use sidekicks_contracts::webauthn::ceremony::UserHandle;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::account_store::{AccountStore, AccountStoreError, SqlValue};

/// One user: their id, the name a passkey is labeled with, and the user handle every passkey of
/// theirs holds, kept as the base64url text of the handle's bytes.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub(crate) struct UserRecord {
    /// The user's id.
    pub(crate) id: UserId,
    /// The account's display name.
    pub(crate) display_name: FreeFormText<{ usize::MAX }>,
    /// The user handle.
    pub(crate) identity_ref: UserHandle,
}

/// The user `user_id` names, or `None` when there is none.
pub(crate) fn read_user<S: AccountStore>(
    store: &S,
    user_id: &str,
) -> Result<Option<UserRecord>, AccountStoreError> {
    Ok(store
        .query(
            "SELECT id, display_name, identity_ref FROM users WHERE id = ?1",
            &[SqlValue::Text(user_id.to_owned())],
        )?
        .pop())
}
