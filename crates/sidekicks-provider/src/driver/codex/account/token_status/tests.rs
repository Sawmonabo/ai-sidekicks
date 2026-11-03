use std::sync::Arc;

use secrecy::SecretString;
use sidekicks_contracts::provider::account::record::ProviderAuthMode;
use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, CAN_LINK_A_SOCKET, short_socket_folder};

use super::CODEX_TOKEN_STATUS_FOLDER;
use crate::account::read_folder::compose_reads_folder;
use crate::driver::ProviderAccountFolders;
use crate::driver::codex::account::CODEX_EPHEMERAL_CREDENTIAL_STORE;
use crate::driver::codex::account::tests::stand_in_legs;
use crate::driver::codex::service::supervisor::test_service::{
    LAUNCH_ARGUMENTS_FILE, ProgramPerHome, read_tree,
};
use crate::driver::contract::account::ProviderTokenStatusLegs;
use crate::runtime_binding::test_store::test_provider_account_id;

/// The pasted key the read hands over; no real key.
const TEST_KEY: &str = "sk-test-status-read-key-5e1a";

// The read hands the key to a service of its own, in a folder of its own on the ephemeral store,
// and leaves nothing behind. Killed by the read run on the account's home (the stand-in's socket
// lands there, so its tree changes), by the file store or no store (the launch names the
// ephemeral one not once), by no key handed (the stand-in's account read then answers nothing,
// which fails the read), and by the read's folder left behind.
#[tokio::test(flavor = "multi_thread")]
async fn a_codex_api_key_status_read_runs_apart_from_the_account_home() {
    if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let folder = short_socket_folder().expect("a scratch folder is made");
    let account_home = folder.path().join("account");
    std::fs::create_dir_all(&account_home).expect("the home is made");
    std::fs::write(account_home.join("config.toml"), b"model = \"gpt-5\"\n")
        .expect("the home's file is written");
    let before = read_tree(&account_home);
    let records_folder = folder.path().to_owned();
    let (legs, _script) = stand_in_legs(folder.path(), &account_home, &[], |program| {
        Arc::new(ProgramPerHome {
            program,
            records_folder,
        })
    });
    let folders = ProviderAccountFolders {
        configuration_folder: account_home.clone(),
        credential_store_folder: account_home.clone(),
    };

    let read = legs
        .read_token_status(
            &test_provider_account_id(),
            &folders,
            &SecretString::from(TEST_KEY),
        )
        .await
        .expect("the read answers");

    assert_eq!(read, Some(ProviderAuthMode::ApiKey));
    assert_eq!(
        read_tree(&account_home),
        before,
        "the account's home changed"
    );
    assert!(!account_home.join("auth.json").exists());
    let reads = compose_reads_folder(&legs.dependencies.data_folder, &CODEX_TOKEN_STATUS_FOLDER);
    let left = std::fs::read_dir(&reads)
        .expect("the reads' folder stays")
        .count();
    assert_eq!(left, 0, "the read's own folder is removed after it");
    let arguments = std::fs::read_to_string(folder.path().join(LAUNCH_ARGUMENTS_FILE))
        .expect("the launch's arguments were kept");
    let ephemeral_stores = arguments
        .lines()
        .filter(|argument| *argument == CODEX_EPHEMERAL_CREDENTIAL_STORE)
        .count();
    assert_eq!(ephemeral_stores, 1, "{arguments}");
}
