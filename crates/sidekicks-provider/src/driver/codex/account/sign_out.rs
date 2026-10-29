//! Codex's sign-out of one account's home: `account/logout` on the service running in that home,
//! or on a short-lived one started there for it, so it removes that home's sign-in and no other.

use std::sync::Arc;

use sidekicks_contracts::provider::account::record::ProviderAccountId;

use crate::driver::ProviderAccountFolders;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome, CodexServiceKind};
use crate::driver::codex::service::registry::home_socket_path;
use crate::driver::codex::service::supervisor::drain::LastingServiceDrains;
use crate::driver::codex::service::supervisor::{
    CodexService, CodexServiceDependencies, CodexServiceSocket,
};
use crate::driver::contract::error::DriverError;

/// The request that signs a Codex home out; it takes no params.
const CODEX_ACCOUNT_LOGOUT_METHOD: &str = "account/logout";

/// The switch that keeps a short-lived service's sign-in in the home's own `auth.json`, as on
/// every Codex process of an account home.
const CODEX_FILE_CREDENTIAL_STORE: &str = "cli_auth_credentials_store=\"file\"";

/// Sends `account/logout` on the service running in `folders`' Codex home, or, where none runs,
/// on a short-lived service started there and stopped after. Fails as the start or the request
/// does, Codex's refusal among them.
pub(super) async fn sign_out_codex_home(
    legs: &CodexAccountLegs,
    provider_account_id: ProviderAccountId,
    folders: ProviderAccountFolders,
) -> Result<(), DriverError> {
    let codex_home = folders.configuration_folder;
    let running = legs
        .registry
        .service_on(&codex_home)
        .filter(|service| service.is_serving());
    if let Some(service) = running {
        return log_out(&service).await;
    }
    let home_socket = home_socket_path(&codex_home);
    let service = CodexService::new(
        CodexServiceHome {
            codex_home,
            kind: CodexHomeKind::Account(provider_account_id),
        },
        CodexServiceSocket {
            path: home_socket.clone(),
            home_socket,
        },
        CodexServiceKind::Account,
        compose_short_lived_dependencies(&legs.dependencies),
    );
    let signed_out = log_out(&service).await;
    service.stop().await;
    signed_out
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

// What a short-lived service runs on: the driver's own services' dependencies with the file
// credential store added, and drains of its own, since it is never a lasting service.
fn compose_short_lived_dependencies(
    shared: &CodexServiceDependencies,
) -> Arc<CodexServiceDependencies> {
    let mut additional_config_overrides = shared.additional_config_overrides.clone();
    additional_config_overrides.push(CODEX_FILE_CREDENTIAL_STORE.to_owned());
    Arc::new(CodexServiceDependencies {
        spawner: shared.spawner.clone(),
        provider_services: Arc::clone(&shared.provider_services),
        processes: Arc::clone(&shared.processes),
        program: Arc::clone(&shared.program),
        data_folder: shared.data_folder.clone(),
        logs_folder: shared.logs_folder.clone(),
        additional_config_overrides,
        startup_timeout: shared.startup_timeout,
        dispatches_hook_mode: shared.dispatches_hook_mode,
        events: Arc::clone(&shared.events),
        release: Arc::clone(&shared.release),
        drains: LastingServiceDrains::default(),
        tasks: shared.tasks.clone(),
        exec_relay: Arc::clone(&shared.exec_relay),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{Value, json};
    use sidekicks_contracts::provider::account::record::ProviderAccountId;

    use crate::driver::ProviderAccountFolders;
    use crate::driver::codex::account::CodexAccountLegs;
    use crate::driver::codex::service::registry::CodexServiceRegistry;
    use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
    use crate::driver::contract::account::ProviderAccountLegs;
    use crate::runtime_binding::test_store::test_provider_account_id;

    // Killed by a sign-out sent on a service other than the named home's, the person's own folder
    // or another account's, and by one the named home's service never receives.
    #[tokio::test]
    async fn sign_out_logs_out_on_the_named_home_s_service_and_no_other() {
        let mut scripted = start_scripted_codex_service();
        let legs = CodexAccountLegs::new(
            CodexServiceRegistry::holding(&scripted),
            Arc::clone(&scripted.dependencies),
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
