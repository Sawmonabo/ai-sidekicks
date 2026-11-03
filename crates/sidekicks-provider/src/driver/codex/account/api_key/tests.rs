use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use secrecy::SecretString;
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::port_registration::PortRegistration;

use super::{hand_resupplied_codex_key, read_codex_api_key};
use crate::driver::codex::account::login::{CODEX_LOGIN_START_METHOD, CodexLoginAccountParams};
use crate::driver::codex::service::registry::CodexServiceRegistry;
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_api_key_service_for,
};
use crate::driver::codex::service::switching::test_sign_in::AccountHomes;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::contract::error::DriverError;
use crate::driver::{ProviderAccountFolders, ProviderAccountReader};
use crate::runtime_binding::test_store::test_provider_account_id;

/// A key the test pastes, long enough that no byte run of it shows by chance.
const TEST_KEY: &str = "sk-a-key-the-test-pastes-and-never-prints";

// Fails when an account with no key sealed is handed an empty one, which would leave its service
// running signed out, or is refused with any code but `provider.account.notAuthenticated`.
#[tokio::test]
async fn an_account_with_no_key_sealed_is_refused_as_not_signed_in() {
    let provider_accounts: PortRegistration<Arc<dyn ProviderAccountReader>> =
        PortRegistration::new("provider accounts");
    AccountHomes {
        homes: HashMap::new(),
        current: test_provider_account_id(),
        api_keys: HashMap::new(),
    }
    .register_on(&provider_accounts);

    let read = read_codex_api_key(&provider_accounts, &test_provider_account_id()).await;

    let Err(CodexError::Driver(DriverError::Refused(refusal))) = read else {
        panic!("the read was not refused: {read:?}");
    };
    assert_eq!(refusal.code, RefusalCode::ProviderAccountNotAuthenticated);
}

// Fails when the key's login prints the key, as a plain text field would, or does not carry it
// under `apiKey`, where Codex reads it.
#[test]
fn a_key_s_login_carries_the_key_on_the_wire_and_never_prints_it() {
    let login = CodexLoginAccountParams::ApiKey {
        api_key: SecretString::from(TEST_KEY),
    };

    let printed = format!("{login:?}");
    let encoded = serde_json::to_value(&login).expect("the login encodes");

    assert!(!printed.contains(TEST_KEY), "the key printed: {printed}");
    assert_eq!(encoded, json!({"type": "apiKey", "apiKey": TEST_KEY}));
}

/// The key the person pastes again in place of the one the services started on.
const NEW_KEY: &str = "sk-the-key-the-person-pastes-again";

// The folders of the account whose home `scripted`'s service runs on.
fn folders_of(scripted: &ScriptedCodexService) -> ProviderAccountFolders {
    let home = scripted.service.home().codex_home.clone();
    ProviderAccountFolders {
        configuration_folder: home.clone(),
        credential_store_folder: home,
    }
}

// Killed by no hand (A's service is sent no login), by the hand sent to every serving service (B's
// is sent one), and by a stopped service started to take it (its start fails on the scripted
// program, failing the hand, or it is sent the login).
#[tokio::test]
async fn a_resupplied_key_reaches_the_running_key_service_and_no_other() {
    let account_a = test_provider_account_id();
    let account_b = ProviderAccountId::new("account-b".to_owned()).expect("an account id fits");
    let mut on_a = start_scripted_api_key_service_for(account_a.clone());
    let mut on_b = start_scripted_api_key_service_for(account_b);
    let registry = CodexServiceRegistry::holding(&on_a);
    registry.hold(&on_b.service);
    let dependencies = Arc::clone(&on_a.dependencies);
    let folders = folders_of(&on_a);
    let new_key = SecretString::from(NEW_KEY);

    let (handed, login) = tokio::join!(
        hand_resupplied_codex_key(&registry, &dependencies, &account_a, &folders, &new_key),
        async {
            let login = tokio::time::timeout(
                Duration::from_secs(5),
                on_a.next_request(CODEX_LOGIN_START_METHOD),
            )
            .await
            .expect("A's service is sent the key's login");
            on_a.script.answer(&login, &json!({"type": "apiKey"}));
            login
        }
    );

    handed.expect("the running service takes the key");
    assert_eq!(
        login["params"],
        json!({"type": "apiKey", "apiKey": NEW_KEY})
    );
    assert!(
        on_b.script.sent.try_recv().is_err(),
        "B's service was sent the key"
    );

    let _set_aside = on_a.publish_crash_loop();
    hand_resupplied_codex_key(&registry, &dependencies, &account_a, &folders, &new_key)
        .await
        .expect("a stopped service is handed nothing");

    assert!(
        !on_a.service.is_serving(),
        "the stopped service was started"
    );
    assert!(
        on_a.script.sent.try_recv().is_err(),
        "the stopped service was sent the key"
    );
}
