use std::collections::HashMap;
use std::sync::Arc;

use secrecy::SecretString;
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_std::port_registration::PortRegistration;

use super::read_codex_api_key;
use crate::driver::ProviderAccountReader;
use crate::driver::codex::account::login::CodexLoginAccountParams;
use crate::driver::codex::service::switching::test_sign_in::AccountHomes;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::contract::error::DriverError;
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
