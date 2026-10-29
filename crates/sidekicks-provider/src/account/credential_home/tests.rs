use std::fs;
use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::{
    BillingMode, ProviderAccountHealthState, ProviderAccountId,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::real_path;
use sidekicks_store::data_folder::agent_memory_folder;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};

use super::{
    CredentialHomeCondition, classify_credential_home, create_credential_home,
    reset_credential_home,
};
use crate::account::registry::{
    AccountAdmission, HealthObservation, PROVIDER_ACCOUNT_REGISTRY_STATEMENT_CAPACITY,
    ProviderAccountRegistry,
};
use crate::driver::ProviderAccountFolders;
use crate::driver::contract::account::ProviderAccountLegs;
use crate::driver::contract::error::DriverError;
use crate::driver::schema::schema_parts;

fn claude() -> ProviderId {
    ProviderId::new("claude".to_owned()).expect("the Claude Code provider id")
}

// Account legs whose sign-out records the account and folders it ran for and succeeds.
#[derive(Default)]
struct RecordedSignOuts(Mutex<Vec<(ProviderAccountId, ProviderAccountFolders)>>);

impl ProviderAccountLegs for RecordedSignOuts {
    fn sign_out_home(
        &self,
        provider_account_id: ProviderAccountId,
        folders: ProviderAccountFolders,
    ) -> BoxFuture<'_, Result<(), DriverError>> {
        self.0
            .lock()
            .expect("the record is not poisoned")
            .push((provider_account_id, folders));
        Box::pin(async { Ok(()) })
    }
}

// A reset signs the account out in the folders it was handed, then empties the home in place:
// the folder stays, its files go, the shared memory behind its link is untouched, and the account
// reads signed out at a raised generation. Killed by the home's folder deleted rather than
// emptied, which reads as absent.
#[tokio::test]
async fn a_reset_leaves_a_husked_home_that_reads_signed_out_and_keeps_its_folder() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let writer = Arc::new(
        DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database"),
    );
    let reads = DatabaseReadPool::new(
        database.path(),
        PROVIDER_ACCOUNT_REGISTRY_STATEMENT_CAPACITY,
    );
    let registry =
        ProviderAccountRegistry::new(Arc::new(reads), writer, data_folder.path().to_owned());
    let minted = registry.mint(claude()).expect("the account is minted");
    let account = registry
        .admit(
            &minted,
            &AccountAdmission {
                display_label: None,
                billing_mode: BillingMode::Subscription,
                health: HealthObservation {
                    state: ProviderAccountHealthState::Authenticated,
                    observed_at: WireInstant::now(),
                },
                observed_auth_mode: None,
            },
        )
        .await
        .expect("the account is admitted");
    let home = account.credential_home.path();
    fs::create_dir_all(home.join("projects/a-project")).expect("a project folder is made");
    fs::write(home.join("projects/a-project/one.jsonl"), b"{}").expect("a transcript is kept");
    fs::write(home.join("settings.json"), b"{}").expect("the settings are kept");
    fs::write(home.join("agent-memory/notes.md"), b"learned").expect("a memory is kept");
    let folders = ProviderAccountFolders {
        configuration_folder: home.to_owned(),
        credential_store_folder: home.join("store"),
    };
    let legs = RecordedSignOuts::default();

    let generation = reset_credential_home(
        &registry,
        &legs,
        account.account_id.clone(),
        folders.clone(),
    )
    .await
    .expect("the home is reset");

    assert_eq!(
        *legs.0.lock().expect("the record is not poisoned"),
        [(account.account_id.clone(), folders)]
    );
    let names: Vec<_> = fs::read_dir(home)
        .expect("the home's folder is still there")
        .map(|entry| entry.expect("an entry reads").file_name())
        .collect();
    assert_eq!(names, ["agent-memory"]);
    assert_eq!(
        fs::read(agent_memory_folder(data_folder.path()).join("notes.md"))
            .expect("the shared memory is kept"),
        b"learned"
    );
    let after = registry
        .read(account.account_id.clone())
        .await
        .expect("the account reads");
    assert_eq!(after.credential_generation, generation);
    assert!(generation > account.credential_generation);
    let health = after.health.map(|health| health.state);
    assert_eq!(health, Some(ProviderAccountHealthState::ReauthRequired));
    assert_eq!(
        classify_credential_home(&after.credential_home, health).expect("the home is looked at"),
        CredentialHomeCondition::Husked
    );
}

// A Claude Code home's `agent-memory` is the daemon's one all-projects memory folder. Killed by
// the link aimed at the person's own Claude Code memory folder, or at none.
#[test]
fn a_claude_code_home_s_agent_memory_resolves_to_the_all_projects_folder() {
    let data_folder = tempfile::tempdir().expect("a data folder");
    let account_id = ProviderAccountId::new("0123456789abcdef0123456789abcdef".to_owned())
        .expect("a test account id");

    let home = create_credential_home(data_folder.path(), &claude(), &account_id)
        .expect("the home is made");

    assert_eq!(
        real_path(&home.path().join("agent-memory")).expect("the link resolves"),
        real_path(&agent_memory_folder(data_folder.path())).expect("the shared folder resolves")
    );
}
