use std::collections::BTreeSet;
use std::sync::Arc;

use rmcp::transport::auth::{AuthError, CredentialStore as _, StoredCredentials};
use rstest::rstest;
use secrecy::SecretString;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_store::credential_store::service::KeychainService;
use sidekicks_store::credential_store::test_keychain::{CountingKeychain, test_keychain};

use super::SignInCustody;
use crate::sign_in::address_digest::ServerAddressDigest;

fn server_address() -> McpServerAddress {
    McpServerAddress::new("https://docs.example.com/mcp").expect("a server address")
}

/// Credentials whose access token is `access_token`; every token is made up for the test.
fn credentials(access_token: &str) -> StoredCredentials {
    let token_response = serde_json::from_value(serde_json::json!({
        "access_token": access_token,
        "token_type": "Bearer",
        "refresh_token": "test-refresh-token",
        "expires_in": 3600,
    }))
    .expect("a token response reads");
    StoredCredentials::new(
        "test-client".to_owned(),
        Some(token_response),
        vec![],
        Some(1),
    )
}

/// The digest `custody` keeps the server at `address` under.
async fn digest_of(custody: &SignInCustody, address: &McpServerAddress) -> ServerAddressDigest {
    custody
        .digest(address)
        .await
        .expect("the address key is made")
}

/// Keeps a sign-in whose access token is `access_token` for the server at `address`, as a
/// sign-in attempt begun now does.
async fn keep(custody: &Arc<SignInCustody>, address: &McpServerAddress, access_token: &str) {
    let digest = digest_of(custody, address).await;
    custody
        .attempt_credential_store(
            &digest,
            address,
            custody.sign_out_generation(&digest),
            None,
            None,
        )
        .save(credentials(access_token))
        .await
        .expect("the sign-in is kept");
}

fn access_token(credentials: &StoredCredentials) -> serde_json::Value {
    serde_json::to_value(credentials).expect("credentials write as JSON")["token_response"]
        ["access_token"]
        .clone()
}

/// A sign-in an earlier daemon life kept is read from the keychain once, however many stores
/// rmcp's managers build for the server load it after. Killed by reading the keychain on every
/// load, and by a cache kept per store rather than per custody.
#[tokio::test]
async fn a_kept_sign_in_is_read_from_the_keychain_once() {
    let (_data_folder, _credentials, keychain) = test_keychain(KeychainService::McpSignIns);
    keep(
        &SignInCustody::new(Arc::clone(&keychain)),
        &server_address(),
        "test-access-token",
    )
    .await;
    let counting = Arc::new(CountingKeychain::new(keychain));
    let custody = SignInCustody::new(Arc::clone(&counting) as _);
    let digest = digest_of(&custody, &server_address()).await;

    for _ in 0..11 {
        let loaded = custody
            .credential_store(&digest, &server_address())
            .load()
            .await
            .expect("the keychain answers")
            .expect("the sign-in is kept");
        assert_eq!(access_token(&loaded), "test-access-token");
    }

    // One read of the address key, one of the sign-in.
    assert_eq!(counting.reads(), 2);
}

/// A server's address written with and without a trailing slash reads one keychain item. Killed by
/// a canonical address that keeps the slash, under which the second spelling reads nothing.
#[tokio::test]
async fn an_address_with_a_trailing_slash_reads_the_same_sign_in() {
    let (_data_folder, _credentials, keychain) = test_keychain(KeychainService::McpSignIns);
    keep(
        &SignInCustody::new(Arc::clone(&keychain)),
        &server_address(),
        "test-access-token",
    )
    .await;
    let slashed = McpServerAddress::new("https://docs.example.com/mcp/").expect("a server address");

    let custody = SignInCustody::new(keychain);
    let loaded = custody
        .credential_store(&digest_of(&custody, &slashed).await, &slashed)
        .load()
        .await
        .expect("the keychain answers")
        .expect("the sign-in is kept under the folded address");

    assert_eq!(access_token(&loaded), "test-access-token");
}

/// A save the keychain refuses comes back refused, and the server's sign-in stays the one held
/// before it. Killed by writing memory before the keychain.
#[tokio::test]
async fn a_refused_save_keeps_the_sign_in_held_before_it() {
    let (_data_folder, platform_store, keychain) = test_keychain(KeychainService::McpSignIns);
    let custody = SignInCustody::new(keychain);
    let address = server_address();
    let digest = digest_of(&custody, &address).await;
    let store = custody.attempt_credential_store(
        &digest,
        &address,
        custody.sign_out_generation(&digest),
        None,
        None,
    );
    store
        .save(credentials("test-access-token-1"))
        .await
        .expect("the first sign-in is kept");
    platform_store.refuse_next_call(KeychainService::McpSignIns.as_str(), digest.as_str());

    let refused = store.save(credentials("test-access-token-2")).await;

    assert!(
        matches!(refused, Err(AuthError::CredentialStoreError(_))),
        "the refused write is returned"
    );
    let loaded = store
        .load()
        .await
        .expect("the held sign-in is read")
        .expect("the sign-in is still held");
    assert_eq!(access_token(&loaded), "test-access-token-1");
}

/// An attempt that began before a sign-out never keeps its sign-in: its save is refused, the
/// keychain holds nothing and the server reads signed out, while an attempt begun after the
/// sign-out keeps its own. Killed by a save that skips the sign-out count, by a sign-out that
/// does not count, and by a refused save that still marks the server signed in.
#[tokio::test]
async fn a_sign_in_begun_before_a_sign_out_is_never_kept() {
    let (_data_folder, _platform_store, keychain) = test_keychain(KeychainService::McpSignIns);
    let custody = SignInCustody::new(Arc::clone(&keychain));
    let address = server_address();
    let digest = digest_of(&custody, &address).await;
    keep(&custody, &address, "test-access-token-1").await;
    let begun_before = custody.attempt_credential_store(
        &digest,
        &address,
        custody.sign_out_generation(&digest),
        None,
        None,
    );

    custody
        .sign_out(&digest)
        .await
        .expect("the sign-out removes the sign-in");
    let refused = begun_before.save(credentials("test-access-token-2")).await;

    assert!(matches!(refused, Err(AuthError::CredentialStoreError(_))));
    assert!(
        keychain
            .read(digest.as_str())
            .await
            .expect("the keychain answers")
            .is_none()
    );
    assert!(!custody.signed_in_servers().borrow().contains(&digest));

    custody
        .attempt_credential_store(
            &digest,
            &address,
            custody.sign_out_generation(&digest),
            None,
            None,
        )
        .save(credentials("test-access-token-3"))
        .await
        .expect("a sign-in begun after the sign-out is kept");
    assert!(custody.signed_in_servers().borrow().contains(&digest));
}

/// The sign-out answers the sign-in it removed, the last one kept, and leaves nothing held in
/// memory or the keychain. Killed by answering an earlier sign-in, and by a sign-out that
/// leaves the item or the memory behind.
#[tokio::test]
async fn a_sign_out_answers_the_sign_in_it_removed() {
    let (_data_folder, _platform_store, keychain) = test_keychain(KeychainService::McpSignIns);
    let custody = SignInCustody::new(Arc::clone(&keychain));
    let address = server_address();
    keep(&custody, &address, "test-access-token-1").await;
    keep(&custody, &address, "test-access-token-2").await;
    let digest = digest_of(&custody, &address).await;
    let store = custody.credential_store(&digest, &address);

    let removed = custody
        .sign_out(&digest)
        .await
        .expect("the keychain answers")
        .expect("a sign-in was held");

    assert_eq!(access_token(&removed.credentials), "test-access-token-2");
    assert!(store.load().await.expect("the custody answers").is_none());
    assert!(
        keychain
            .read(digest.as_str())
            .await
            .expect("the keychain answers")
            .is_none()
    );
}

/// What lands while a renewal is under way, and when.
#[derive(Clone, Copy)]
enum DuringRenewal {
    /// A sign-out, after the renewal loaded its sign-in.
    SignOut,
    /// A new sign-in, after the renewal loaded its sign-in.
    NewSignIn,
    /// A new sign-in, after rmcp took the refresh guard and before the renewal loaded.
    NewSignInFirst,
}

/// A renewal's save keeps its tokens only over the sign-in the renewal loaded under rmcp's guard:
/// one a sign-out removed stays out and the server reads signed out, one a new sign-in replaced
/// stays the new sign-in, and each refused save's tokens are kept aside to be revoked; a sign-in
/// kept before the load is the one renewed, so its save is kept. Killed by a renewal's save that
/// writes over whatever is held, or over nothing, by a base recorded when the guard is taken
/// rather than at the load, and by a refused save whose tokens are dropped.
#[rstest]
#[case::a_sign_out(DuringRenewal::SignOut)]
#[case::a_new_sign_in(DuringRenewal::NewSignIn)]
#[case::a_new_sign_in_before_the_load(DuringRenewal::NewSignInFirst)]
#[tokio::test]
async fn a_renewal_keeps_its_tokens_only_over_the_sign_in_it_loaded(
    #[case] during_renewal: DuringRenewal,
) {
    let (_data_folder, _platform_store, keychain) = test_keychain(KeychainService::McpSignIns);
    let custody = SignInCustody::new(Arc::clone(&keychain));
    let address = server_address();
    let digest = digest_of(&custody, &address).await;
    keep(&custody, &address, "test-access-token-1").await;
    let renewal = custody.credential_store(&digest, &address);
    let guard = renewal
        .acquire_refresh_guard()
        .await
        .expect("the custody answers");

    match during_renewal {
        DuringRenewal::SignOut => {
            renewal.load().await.expect("the custody answers");
            custody
                .sign_out(&digest)
                .await
                .expect("the sign-out removes the sign-in");
        }
        DuringRenewal::NewSignIn => {
            renewal.load().await.expect("the custody answers");
            keep(&custody, &address, "test-access-token-3").await;
        }
        DuringRenewal::NewSignInFirst => {
            keep(&custody, &address, "test-access-token-3").await;
            renewal.load().await.expect("the custody answers");
        }
    }
    let saved = renewal.save(credentials("test-access-token-2")).await;
    drop(guard);

    let (is_kept, held_token) = match during_renewal {
        DuringRenewal::SignOut => (false, None),
        DuringRenewal::NewSignIn => (false, Some("test-access-token-3")),
        DuringRenewal::NewSignInFirst => (true, Some("test-access-token-2")),
    };
    assert_eq!(saved.is_ok(), is_kept, "{saved:?}");
    let held = renewal.load().await.expect("the custody answers");
    assert_eq!(
        held.as_ref().map(access_token),
        held_token.map(|token| serde_json::json!(token))
    );
    assert_eq!(
        custody.signed_in_servers().borrow().contains(&digest),
        held_token.is_some()
    );
    let refused = renewal.take_refused_renewal();
    assert_eq!(
        refused.map(|refused| access_token(&refused.credentials)),
        (!is_kept).then(|| serde_json::json!("test-access-token-2"))
    );
}

/// The start's seed marks signed in each server the keychain files a sign-in for that this daemon
/// life has not read yet, and leaves a server already read as its read found it, so a seed that
/// ends after a sign-out never undoes it. Killed by a seed that marks nothing, and by one that
/// marks a server already read.
#[tokio::test]
async fn the_seed_marks_only_the_filed_servers_this_life_has_not_read() {
    let (_data_folder, _credentials, keychain) = test_keychain(KeychainService::McpSignIns);
    let custody = SignInCustody::new(Arc::clone(&keychain));
    let unread = McpServerAddress::new("https://unread.example.test/mcp").expect("an address");
    let read = McpServerAddress::new("https://read.example.test/mcp").expect("an address");
    // Read while the keychain held nothing for it, as a sign-out leaves it, and filed after.
    let held = custody
        .credential_store(&digest_of(&custody, &read).await, &read)
        .held()
        .await
        .expect("the keychain reads");
    assert!(held.is_none());
    for address in [&unread, &read] {
        keychain
            .write(
                digest_of(&custody, address).await.as_str(),
                &SecretString::from("not read by the seed".to_owned()),
            )
            .await
            .expect("the keychain keeps the item");
    }

    custody
        .seed_signed_in()
        .await
        .expect("the keychain lists its items");

    assert_eq!(
        *custody.signed_in_servers().borrow(),
        BTreeSet::from([digest_of(&custody, &unread).await])
    );
}
