use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::daemon::data::DataEraseAccountListing;
use sidekicks_contracts::provider::account::record::{
    BillingMode, ProviderAccountHealthState, ProviderAccountId,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::{has_file_mode, real_path};
use sidekicks_store::data_folder::agent_memory_folder;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement};
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::marks::mark_removed;
use super::test_legs::RecordedSignOuts;
use super::{
    CredentialHomeCondition, classify_credential_home, create_credential_home,
    reset_credential_home, sign_out_every_home,
};
use crate::account::home_lock::AccountHomeLock;
use crate::account::registry::{
    AccountAdmission, HealthObservation, PROVIDER_ACCOUNT_REGISTRY_STATEMENT_CAPACITY,
    ProviderAccountRegistry, RegisteredAccount, open_test_registry,
};
use crate::account::resolver::credential_home_folders;
use crate::driver::ProviderAccountFolders;
use crate::driver::contract::account::ProviderAccountLegs;
use crate::driver::schema::schema_parts;

fn claude() -> ProviderId {
    ProviderId::new("claude".to_owned()).expect("the Claude Code provider id")
}

// A Claude Code account admitted signed in.
async fn admit_signed_in(registry: &ProviderAccountRegistry) -> RegisteredAccount {
    let minted = registry.mint(claude()).expect("the account is minted");
    registry
        .admit(
            &minted,
            &AccountAdmission {
                display_label: None,
                billing_mode: BillingMode::Subscription,
                health: Some(HealthObservation {
                    state: ProviderAccountHealthState::Authenticated,
                    observed_at: WireInstant::now(),
                }),
                observed_auth_mode: None,
            },
        )
        .await
        .expect("the account is admitted")
}

// A reset signs the account out in the folders it was handed, then empties the home in place:
// the folder stays, its files go, the shared memory behind its link is untouched, and the account
// reads signed out at a raised generation. Killed by the home's folder deleted rather than
// emptied, which reads as absent.
#[tokio::test]
async fn a_reset_leaves_a_husked_home_that_reads_signed_out_and_keeps_its_folder() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
    let account = admit_signed_in(&registry).await;
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
        &AccountHomeLock::default(),
        &legs,
        account.account_id.clone(),
        folders.clone(),
    )
    .await
    .expect("the home is reset");

    assert_eq!(legs.signed_out(), [(account.account_id.clone(), folders)]);
    let mut names: Vec<_> = fs::read_dir(home)
        .expect("the home's folder is still there")
        .map(|entry| entry.expect("an entry reads").file_name())
        .collect();
    names.sort();
    assert_eq!(names, ["agent-memory", "store"]);
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

// A Claude Code home's `agent-memory` is the daemon's one all-projects memory folder, and its
// credential store folder stands from the mint, readable by its owner alone. Killed by the link
// aimed at the person's own Claude Code memory folder, or at none, or by a mint that leaves the
// store folder to the provider.
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
    let store = home.path().join("store");
    assert!(
        fs::metadata(&store)
            .expect("the store folder stands")
            .is_dir()
    );
    assert!(has_file_mode(&store, 0o700).expect("the store folder's mode reads"));
}

// Every home the erase deletes is signed out in its own folders before the homes go: a listed
// account's, one whose removal has begun, a removed account's kept home and one minted for a
// sign-in that did not finish, while a removed mark whose home is gone signs nothing out; each
// refused one is answered with its provider and how it stood on the list; a row whose provider is
// no provider id is answered as unnamed while the rest still sign out. Killed by a row
// mid-removal skipped, by the removed or the minted marks unread, by a gone home signed out, by
// the listing or the provider wrong, by a sign-out run in another account's folders, by the
// unnamed row not answered, and by an unnamed row failing the whole read.
#[tokio::test]
async fn every_home_the_erase_deletes_is_signed_out_and_a_refused_one_is_answered() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let (registry, writer) = open_test_registry(&database, data_folder.path()).await;
    // The workflow crate's table, cut to the columns the removal's guard reads.
    writer
        .write(vec![WriteStatement {
            sql: Cow::Borrowed(
                "CREATE TABLE workflow_steps (
                   workflow_run_id TEXT, wait_account_id TEXT, status TEXT, wait_cause TEXT
                 )",
            ),
            bindings: StatementBindings::None,
            expected_row_count: None,
        }])
        .await
        .expect("the table is made");
    let listed = admit_signed_in(&registry).await;
    let removing = admit_signed_in(&registry).await;
    registry
        .mark_removal_intent(&removing.account_id)
        .await
        .expect("the removal begins");
    let removed = admit_signed_in(&registry).await;
    registry
        .mark_removal_intent(&removed.account_id)
        .await
        .expect("the removal begins");
    registry
        .delete_marked_account(&removed.account_id)
        .await
        .expect("the row goes");
    let unfinished = registry.mint(claude()).expect("an account is minted");
    let gone = ProviderAccountId::new("account-gone".to_owned()).expect("a test account id");
    mark_removed(data_folder.path(), &gone, &claude()).expect("a home with no folder is marked");
    writer
        .write(vec![WriteStatement {
            sql: Cow::Borrowed(
                "INSERT INTO provider_accounts (account_id, provider, credential_home_path,
                   billing_mode, created_at, updated_at)
                 VALUES ('account-unnamed', 'Not A Provider', '/nowhere', 'unknown',
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            ),
            bindings: StatementBindings::None,
            expected_row_count: Some(1),
        }])
        .await
        .expect("a damaged row is stored");
    let reads = DatabaseReadPool::new(
        database.path(),
        PROVIDER_ACCOUNT_REGISTRY_STATEMENT_CAPACITY,
    );
    let legs = Arc::new(RecordedSignOuts::refusing([
        removing.account_id.clone(),
        removed.account_id.clone(),
        unfinished.account_id().clone(),
    ]));

    let answered = sign_out_every_home(
        &reads,
        data_folder.path(),
        &HashMap::from([(claude(), Arc::clone(&legs) as Arc<dyn ProviderAccountLegs>)]),
        Duration::from_secs(5),
    )
    .await
    .expect("the homes read");

    assert!(answered.has_unnamed_home, "the damaged row is answered");
    let mut failed: Vec<_> = answered
        .left_signed_in
        .into_iter()
        .map(|left| (left.account_id, left.provider, left.listing))
        .collect();
    failed.sort_by(|left, right| left.0.as_str().cmp(right.0.as_str()));
    let mut expected_failed = [
        (
            removing.account_id.clone(),
            DataEraseAccountListing::Removed,
        ),
        (removed.account_id.clone(), DataEraseAccountListing::Removed),
        (
            unfinished.account_id().clone(),
            DataEraseAccountListing::SignInUnfinished,
        ),
    ]
    .map(|(account_id, listing)| (account_id, claude(), listing));
    expected_failed.sort_by(|left, right| left.0.as_str().cmp(right.0.as_str()));
    assert_eq!(failed, expected_failed);
    let mut signed_out = legs.signed_out();
    signed_out.sort_by(|left, right| left.0.as_str().cmp(right.0.as_str()));
    let mut expected = [
        (listed.account_id, listed.credential_home),
        (removing.account_id, removing.credential_home),
        (removed.account_id, removed.credential_home),
        (unfinished.account_id().clone(), unfinished.home().clone()),
    ]
    .map(|(account_id, home)| (account_id, credential_home_folders(&claude(), &home)));
    expected.sort_by(|left, right| left.0.as_str().cmp(right.0.as_str()));
    assert_eq!(signed_out, expected);
}
