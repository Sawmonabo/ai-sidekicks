//! The account's passkeys, `webauthn_credentials`: the row a sign-in is checked under, the list a
//! new registration excludes, the insert that keeps the first holder of a credential id, the
//! counter's compare-and-set and the revoke.

use axum::Json;
use axum::extract::{Extension, State};
use jiff::Timestamp;
use serde::Deserialize;
use serde_with::serde_as;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::trust_statement::PasskeyId;
use sidekicks_contracts::webauthn::ceremony::Transports;
use sidekicks_contracts::webauthn::credential::WebAuthnCredentialRevokeRequest;

use crate::account::AccountRoutes;
use crate::account::webauthn::verifier::RegisteredPasskey;
use crate::account_store::{AccountStore, AccountStoreError, SharedAccountStore, SqlValue};
use crate::server::received_json::ReceivedJson;
use crate::server::router::{ControlPlaneRefusal, RequestId, SignedInUser};

/// One stored passkey as a sign-in reads it.
#[serde_as]
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct StoredCredential {
    /// The user the passkey belongs to.
    pub(crate) user_id: String,
    /// The COSE public key's bytes.
    #[serde_as(as = "serde_with::Bytes")]
    pub(crate) public_key: Vec<u8>,
    /// The highest signature counter seen.
    pub(crate) signature_counter: i64,
}

/// A passkey as a registration's `excludeCredentials` lists it.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ListedCredential {
    /// The credential id.
    pub(crate) credential_id: PasskeyId,
    /// The transports it registered with, as JSON text, or `NULL`.
    pub(crate) transports: Option<String>,
}

/// The passkey `credential_id`, or `None` when no user holds it.
pub(crate) fn read_credential<S: AccountStore>(
    store: &S,
    credential_id: &str,
) -> Result<Option<StoredCredential>, AccountStoreError> {
    Ok(store
        .query(
            "SELECT user_id, public_key, signature_counter FROM webauthn_credentials \
             WHERE credential_id = ?1",
            &[SqlValue::Text(credential_id.to_owned())],
        )?
        .pop())
}

/// Every passkey `user_id` holds.
pub(crate) fn list_credentials<S: AccountStore>(
    store: &S,
    user_id: &str,
) -> Result<Vec<ListedCredential>, AccountStoreError> {
    store.query(
        "SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?1 \
         ORDER BY registered_at, credential_id",
        &[SqlValue::Text(user_id.to_owned())],
    )
}

/// Writes `passkey` as `user_id`'s at `now` inside the caller's step; `false` when its credential
/// id is already registered to any user, whose row is kept as it is.
pub(crate) fn insert_credential<S: AccountStore>(
    store: &S,
    user_id: &str,
    passkey: &RegisteredPasskey,
    transports: Option<&Transports>,
    now: Timestamp,
) -> Result<bool, AccountStoreError> {
    let transports = transports
        .map(|transports| serde_json::to_string(transports.as_slice()))
        .transpose()?;
    let inserted: Vec<serde_json::Value> = store.query(
        "INSERT INTO webauthn_credentials (user_id, credential_id, public_key, aaguid, \
         signature_counter, transports, registered_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(credential_id) DO NOTHING RETURNING credential_id",
        &[
            SqlValue::Text(user_id.to_owned()),
            SqlValue::Text(passkey.credential_id.as_str().to_owned()),
            SqlValue::Blob(passkey.public_key.cose_key.decode()),
            SqlValue::Text(passkey.aaguid.as_str().to_owned()),
            SqlValue::Integer(i64::from(passkey.counter)),
            transports.map_or(SqlValue::Null, SqlValue::Text),
            SqlValue::Integer(now.as_second()),
        ],
    )?;
    Ok(!inserted.is_empty())
}

/// Advances `credential_id`'s counter to `counter` and stamps its use at `now` inside the
/// caller's step, only while it is still `user_id`'s and the stored counter is below `counter`,
/// or both are 0 for an authenticator that keeps none; `false` when no row matched.
pub(crate) fn advance_counter<S: AccountStore>(
    store: &S,
    credential_id: &str,
    user_id: &str,
    counter: u32,
    now: Timestamp,
) -> Result<bool, AccountStoreError> {
    let advanced: Vec<serde_json::Value> = store.query(
        "UPDATE webauthn_credentials SET signature_counter = ?2, last_used_at = ?3 \
         WHERE credential_id = ?1 AND user_id = ?4 \
         AND (signature_counter < ?2 OR (signature_counter = 0 AND ?2 = 0)) RETURNING user_id",
        &[
            SqlValue::Text(credential_id.to_owned()),
            SqlValue::Integer(i64::from(counter)),
            SqlValue::Integer(now.as_second()),
            SqlValue::Text(user_id.to_owned()),
        ],
    )?;
    Ok(!advanced.is_empty())
}

/// Revokes one of the signed-in caller's passkeys. A passkey another account holds, or none,
/// is answered the same and left as it is; the account's last passkey may go.
pub(crate) async fn revoke_passkey<S, V, L>(
    State(routes): State<AccountRoutes<S, V, L>>,
    request_id: Option<Extension<RequestId>>,
    caller: SignedInUser,
    ReceivedJson(request): ReceivedJson<WebAuthnCredentialRevokeRequest>,
) -> Result<Json<EmptyPayload>, ControlPlaneRefusal>
where
    S: SharedAccountStore,
{
    let SignedInUser { user_id } = caller;
    routes
        .store
        .run_step(move |store| revoke_credential(store, request.passkey_id.as_str(), &user_id))
        .await
        .map_err(|error| {
            let request_id = request_id.map(|Extension(request_id)| request_id);
            ControlPlaneRefusal::refuse_internal_failure(request_id.as_ref(), &error)
        })?;
    Ok(Json(EmptyPayload {}))
}

/// Deletes `credential_id` when `user_id` holds it; one another user holds, or none, is left.
fn revoke_credential<S: AccountStore>(
    store: &S,
    credential_id: &str,
    user_id: &str,
) -> Result<(), AccountStoreError> {
    store.execute(
        "DELETE FROM webauthn_credentials WHERE credential_id = ?1 AND user_id = ?2",
        &[
            SqlValue::Text(credential_id.to_owned()),
            SqlValue::Text(user_id.to_owned()),
        ],
    )
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use rstest::rstest;

    use super::advance_counter;
    use crate::account_store::{AccountStore, open_account_file};

    // Two sign-ins of one passkey commit in the order given, from a stored counter; answers
    // whether each advanced it, and the counter it settles at.
    #[rstest]
    #[case::equal_counters(5, [6, 6], [true, false], 6)]
    #[case::higher_first(5, [9, 7], [true, false], 9)]
    #[case::lower_first(5, [7, 9], [true, true], 9)]
    #[case::equal_to_stored(5, [5, 4], [false, false], 5)]
    #[case::no_counter_kept(0, [0, 0], [true, true], 0)]
    fn a_counter_advances_only_past_the_stored_one(
        #[case] stored: i64,
        #[case] presented: [u32; 2],
        #[case] advanced: [bool; 2],
        #[case] settled: i64,
    ) {
        let folder = tempfile::tempdir().unwrap();
        let store = open_account_file(&folder.path().join("account.sqlite")).unwrap();
        AccountStore::execute(
            &store,
            "INSERT INTO users (id, display_name, identity_ref) VALUES ('user', 'Sam', 'h')",
            &[],
        )
        .unwrap();
        AccountStore::execute(
            &store,
            &format!(
                "INSERT INTO webauthn_credentials (user_id, credential_id, public_key, \
                     aaguid, signature_counter) VALUES ('user', 'key', x'00', 'a', {stored})"
            ),
            &[],
        )
        .unwrap();
        let now = Timestamp::from_second(1_000).unwrap();

        let answered = presented.map(|counter| {
            store
                .write_step(|step| advance_counter(step, "key", "user", counter, now))
                .unwrap()
        });
        assert_eq!(answered, advanced);
        assert!(
            !advance_counter(&store, "key", "someone else", u32::MAX, now).unwrap(),
            "another user's passkey is never advanced"
        );
        let row: Vec<serde_json::Value> = store
            .query(
                "SELECT signature_counter, last_used_at FROM webauthn_credentials",
                &[],
            )
            .unwrap();
        let stamped = if advanced.contains(&true) {
            serde_json::json!(1_000)
        } else {
            serde_json::Value::Null
        };
        assert_eq!(
            row,
            vec![serde_json::json!({ "signature_counter": settled, "last_used_at": stamped })]
        );
    }
}
