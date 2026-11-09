//! Codex's sign-out of one account's home, so it removes that home's sign-in and no other. The
//! running daemon's account legs send `account/logout` on the service running in that home, or on a
//! short-lived one started there for it; a helper mode's, run with no daemon serving, runs
//! `codex logout` in the home, which signs out through the same code in Codex.

use std::path::Path;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::Spawner;

use crate::driver::ProviderAccountFolders;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::account::login::CODEX_ACCOUNT_LOGOUT_METHOD;
use crate::driver::codex::service::command::run_codex_command_to_exit;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::program::CodexInstalledProgram;
use crate::driver::codex::service::registry::home_exec_switches;
use crate::driver::codex::service::supervisor::start::compose_codex_native_launch;
use crate::driver::codex::service::supervisor::{CodexProgramResolver, CodexService};
use crate::driver::contract::error::DriverError;

/// The Codex subcommand that signs the home it runs in out.
const CODEX_SIGN_OUT_SUBCOMMAND: &str = "logout";

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

/// Runs `codex logout` in `folders`' Codex home with the account home's own switches, its sign-in
/// kept in the home's `auth.json` among them, the build `program` resolves for that home, started
/// on `spawner` in the folder the short-lived services run in under `data_folder`; its output is
/// never read. Fails with the resolve's error, as the launch cannot be composed, and with
/// `DriverError::Internal` naming the exit code or signal when the command cannot start or ends
/// in a failure.
pub(super) async fn run_codex_sign_out(
    program: &CodexInstalledProgram,
    spawner: &Spawner,
    data_folder: &Path,
    provider_account_id: ProviderAccountId,
    folders: ProviderAccountFolders,
) -> Result<(), DriverError> {
    let home = CodexServiceHome {
        codex_home: folders.configuration_folder,
        kind: CodexHomeKind::Account(provider_account_id),
    };
    let executable = program.resolve(&home).await?;
    let mut arguments = home_exec_switches(&home.kind);
    arguments.push(CODEX_SIGN_OUT_SUBCOMMAND.to_owned());
    let launch = compose_codex_native_launch(data_folder, &executable, arguments)
        .await?
        .launch;
    run_codex_command_to_exit(spawner, launch)
        .await
        .map_err(|error| DriverError::Internal(Box::new(error)))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{Value, json};
    use sidekicks_contracts::provider::account::record::ProviderAccountId;

    use sidekicks_std::file::atomic_write::write_file_atomically;
    use sidekicks_std::port_registration::PortRegistration;
    use sidekicks_store::database::writer::test_file::TestDatabase;

    use crate::account::registry::open_test_registry;
    use crate::driver::ProviderAccountFolders;
    use crate::driver::codex::account::CODEX_FILE_CREDENTIAL_STORE;
    use crate::driver::codex::account::CodexAccountLegs;
    use crate::driver::codex::account::helper_mode::CodexHelperModeLegs;
    use crate::driver::codex::rate_limits::CodexRateLimitFiling;
    use crate::driver::codex::service::registry::CodexServiceRegistry;
    use crate::driver::codex::service::supervisor::test_service::start_scripted_codex_service;
    use crate::driver::contract::account::{HelperModeAccountLegs, ProviderAccountLegs};
    use crate::driver::helper_mode_services_over;
    use crate::driver::schema::schema_parts;
    use crate::driver::test_registry::{NothingServed, test_driver_services};
    use crate::runtime_binding::test_store::test_provider_account_id;

    // Killed by a sign-out sent on a service other than the named home's, the person's own folder
    // or another account's, and by one the named home's service never receives.
    #[tokio::test]
    async fn sign_out_logs_out_on_the_named_home_s_service_and_no_other() {
        let mut scripted = start_scripted_codex_service();
        let accounts = tempfile::tempdir().expect("a scratch folder is made");
        let database = TestDatabase::new(schema_parts());
        let (registry, _writer) = open_test_registry(&database, accounts.path()).await;
        let accounts = Arc::new(PortRegistration::new("provider account registry"));
        assert!(accounts.register(Arc::new(registry)).is_ok());
        let legs = CodexAccountLegs::new(
            CodexServiceRegistry::holding(&scripted),
            Arc::clone(&scripted.dependencies),
            CodexRateLimitFiling::new(Arc::new(PortRegistration::new("usage"))),
            accounts,
            Arc::new(NothingServed),
            Arc::new(PortRegistration::new("account home lock")),
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
            scripted
                .script
                .next_sent_within(Duration::from_millis(200))
                .await
                .is_none(),
            "the named home's service received another home's sign-out"
        );
    }

    // A helper mode's legs run `codex logout` in the named account's home with the home's file
    // store switch before it, and a run that exits 1 answers an error. Killed by the store switch
    // missing, which would sign a keyring store out instead, by the home of another account, and
    // by a failed exit answered as a sign-out.
    #[tokio::test]
    async fn the_helper_mode_signs_a_codex_home_out_with_its_file_store() {
        let root = tempfile::tempdir().expect("a scratch folder is made");
        let programs = root.path().join("programs");
        tokio::fs::create_dir_all(&programs)
            .await
            .expect("the programs folder is made");
        let record = root.path().join("sign-outs");
        write_file_atomically(
            &programs.join("codex"),
            format!(
                "#!/bin/sh\n{{ printf '%s\\n' \"$CODEX_HOME\"; printf '%s\\n' \"$@\"; }} >> '{}'\n\
                 [ -e \"$CODEX_HOME/refuse\" ] && exit 1\nexit 0\n",
                record.display()
            ),
            0o755,
        )
        .await
        .expect("the stand-in is written");
        let mut services = test_driver_services();
        services.data_folder = root.path().join("data");
        services.home_folder = root.path().join("home");
        services.base_environment = Arc::from([(
            "PATH".to_owned(),
            format!("{}:/usr/bin:/bin", programs.display()),
        )]);
        let legs = CodexHelperModeLegs::new(&helper_mode_services_over(&services));
        let home_of = |name: &str| {
            let home = root.path().join(name);
            ProviderAccountFolders {
                configuration_folder: home.clone(),
                credential_store_folder: home,
            }
        };
        let (named, refusing) = (home_of("one"), home_of("two"));
        tokio::fs::create_dir_all(&refusing.configuration_folder)
            .await
            .expect("the refusing home is made");
        tokio::fs::write(refusing.configuration_folder.join("refuse"), "")
            .await
            .expect("the refusal is planted");

        legs.sign_out_home(test_provider_account_id(), named.clone())
            .await
            .expect("the sign-out exits cleanly");
        legs.sign_out_home(test_provider_account_id(), refusing.clone())
            .await
            .expect_err("a sign-out that exits 1 is no sign-out");

        let recorded = tokio::fs::read_to_string(&record)
            .await
            .expect("the stand-in ran");
        let run_in = |folders: &ProviderAccountFolders| {
            format!(
                "{}\n-c\n{CODEX_FILE_CREDENTIAL_STORE}\n-c\notel.exporter=\"none\"\n-c\n\
                 otel.trace_exporter=\"none\"\n-c\notel.metrics_exporter=\"none\"\nlogout\n",
                folders.configuration_folder.display()
            )
        };
        assert_eq!(recorded, run_in(&named) + &run_in(&refusing));
    }
}
