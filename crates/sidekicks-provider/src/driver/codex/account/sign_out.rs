//! Codex's sign-out of one account's home: `account/logout` on the service running in that home,
//! or on a short-lived one started there for it, so it removes that home's sign-in and no other.

use sidekicks_contracts::provider::account::record::ProviderAccountId;

use crate::driver::ProviderAccountFolders;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::contract::error::DriverError;

/// The request that signs a Codex home out; it takes no params.
const CODEX_ACCOUNT_LOGOUT_METHOD: &str = "account/logout";

/// Sends `account/logout` on the service running in `folders`' Codex home, or, where none runs,
/// on a short-lived service started there and stopped after. Fails as the start or the request
/// does, Codex's refusal among them.
pub(super) async fn sign_out_codex_home(
    legs: &CodexAccountLegs,
    provider_account_id: ProviderAccountId,
    folders: ProviderAccountFolders,
) -> Result<(), DriverError> {
    legs.act_on_home_service(
        provider_account_id,
        folders.configuration_folder,
        async |service| log_out(service).await,
    )
    .await
}

// Sends the sign-out once `service` is up, waiting out a start or restart under way.
async fn log_out(service: &CodexService) -> Result<(), DriverError> {
    service
        .ensure_started(service.dependencies().startup_timeout)
        .await?;
    service
        .connection()?
        .request(CODEX_ACCOUNT_LOGOUT_METHOD, &())
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{Value, json};
    use sidekicks_contracts::provider::account::record::ProviderAccountId;

    use sidekicks_std::port_registration::PortRegistration;
    use sidekicks_store::database::writer::test_file::TestDatabase;

    use crate::account::registry::open_test_registry;
    use crate::driver::ProviderAccountFolders;
    use crate::driver::codex::account::CodexAccountLegs;
    use crate::driver::codex::rate_limits::CodexRateLimitFiling;
    use crate::driver::codex::service::registry::CodexServiceRegistry;
    use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
    use crate::driver::contract::account::ProviderAccountLegs;
    use crate::driver::schema::schema_parts;
    use crate::runtime_binding::test_store::test_provider_account_id;

    // Killed by a sign-out sent on a service other than the named home's, the person's own folder
    // or another account's, and by one the named home's service never receives.
    #[tokio::test]
    async fn sign_out_logs_out_on_the_named_home_s_service_and_no_other() {
        let mut scripted = start_scripted_codex_service();
        let accounts = tempfile::tempdir().expect("a scratch folder is made");
        let database = TestDatabase::new(schema_parts());
        let (registry, _writer) = open_test_registry(&database, accounts.path()).await;
        let legs = CodexAccountLegs::new(
            CodexServiceRegistry::holding(&scripted),
            Arc::clone(&scripted.dependencies),
            CodexRateLimitFiling::new(Arc::new(PortRegistration::new("usage"))),
            Arc::new(registry),
        );
        let codex_home = scripted.service.home().codex_home.clone();
        let named = ProviderAccountFolders {
            configuration_folder: codex_home.clone(),
            credential_store_folder: codex_home,
        };

        let answered = async {
            let request = scripted.next_request("account/logout").await;
            assert_eq!(request["params"], Value::Null, "{request}");
            scripted.script.answer(&request, &json!({}));
        };
        let (signed_out, ()) = tokio::join!(
            legs.sign_out_home(test_provider_account_id(), named),
            answered
        );
        signed_out.expect("the named home's service signs out");

        let other = tempfile::tempdir().expect("a scratch folder is made");
        let other_folders = ProviderAccountFolders {
            configuration_folder: other.path().to_path_buf(),
            credential_store_folder: other.path().to_path_buf(),
        };
        let other_account = ProviderAccountId::new("account-2".to_owned()).expect("a valid id");
        legs.sign_out_home(other_account, other_folders)
            .await
            .expect_err("a home with no Codex of its own starts its own, which the test cannot");
        assert!(
            tokio::time::timeout(Duration::from_millis(200), scripted.script.next_sent())
                .await
                .is_err(),
            "the named home's service received another home's sign-out"
        );
    }
}
