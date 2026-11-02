use rusqlite::params;
use sidekicks_client::daemon_connection::{DaemonConnection, DaemonEndpoint};
use sidekicks_contracts::provider::account::methods::ProviderAccountList;
use sidekicks_contracts::provider::account::record::ProviderAccountListRequest;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::{CAN_BIND_A_SOCKET_LISTENER, create_missing_private_folders};
use sidekicks_provider::driver::daemon_stop::DaemonStopIntent;
use sidekicks_store::database::connection::writer_open::{
    DAEMON_DATABASE_FILE_NAME, open_database,
};
use tokio_util::sync::CancellationToken;

use super::TestHome;
use crate::daemon::schema::schema_parts;

// The stored account's id.
const ACCOUNT_ID: &str = "0123456789abcdef0123456789abcdef";

// The account a client lists is the row the registry holds: `provider.account.list`, called
// through the typed client against the daemon's served table, answers the stored account. Killed by
// the provider account table left unregistered, where the call is refused as an unknown method.
#[tokio::test(flavor = "multi_thread")]
async fn a_client_lists_the_provider_accounts_the_registry_holds() {
    if !CAN_BIND_A_SOCKET_LISTENER {
        return;
    }
    let home = TestHome::new();
    let data_folder = home.data_folder();
    create_missing_private_folders(&data_folder).expect("the data folder is made");
    let account_home = data_folder.join("account-home");
    std::fs::create_dir(&account_home).expect("the account's home is made");
    let connection = open_database(
        &data_folder.join(DAEMON_DATABASE_FILE_NAME),
        &schema_parts().into_schema(),
    )
    .expect("the store opens");
    let now = WireInstant::now();
    connection
        .execute(
            "INSERT INTO provider_accounts (account_id, provider, credential_home_path,
               billing_mode, is_default, created_at, updated_at)
             VALUES (?1, 'codex', ?2, 'unknown', 1, ?3, ?3)",
            params![
                ACCOUNT_ID,
                account_home.to_str().expect("the home's path is text"),
                now.as_str(),
            ],
        )
        .expect("the account is stored");
    drop(connection);
    let daemon = home
        .start(CancellationToken::new())
        .await
        .expect("the daemon starts");

    let client = DaemonConnection::connect(DaemonEndpoint::new(home.run_folder.clone()))
        .await
        .expect("the handshake completes");
    let listed = client
        .client()
        .call::<ProviderAccountList>(&ProviderAccountListRequest {
            provider: None,
            account_id: None,
        })
        .await;
    client.close().await;
    daemon
        .stop(DaemonStopIntent::Stop)
        .await
        .expect("the daemon's stop fails nothing");

    let listed = listed.expect("the list answers");
    let account_ids: Vec<&str> = listed
        .accounts
        .iter()
        .map(|account| account.account_id().as_str())
        .collect();
    assert_eq!(account_ids, [ACCOUNT_ID]);
}
