use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::provider::account::record::{BillingMode, ProviderAccountHealthState};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_provider::account::credential_home::marks::{
    clear_minted_mark, mark_minted, mark_removed, read_minted_homes,
};
use sidekicks_provider::account::credential_home::test_legs::RecordedSignOuts;
use sidekicks_provider::account::registry::{
    AccountAdmission, HealthObservation, open_test_registry,
};
use sidekicks_provider::driver::contract::account::ProviderAccountLegs;
use sidekicks_provider::driver::schema::schema_parts;
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::LeftoverMintedHomes;

fn claude() -> ProviderId {
    ProviderId::new("claude".to_owned()).expect("the Claude Code provider id")
}

// A start signs out and removes a marked home no row names, keeps one whose sign-out the provider
// refuses, clears the mark of an account a row names and of one whose home was never made, and
// leaves a removed account's home with no row, which carries only a removed mark, as it is. Killed
// by every home no row names removed or the removed marks read (the removed account's home goes),
// by a removal without its sign-out (the record is empty), by a removal past a refused sign-out
// (the refused home goes), by a marked home a row names removed (the admitted home goes), by a
// row's mark left (still marked) and by a sign-out run on a home never made (the record holds the
// unmade account).
#[tokio::test]
async fn a_start_removes_only_the_homes_minted_for_accounts_no_row_took() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
    let stranded = registry
        .mint(claude())
        .expect("a stranded account is minted");
    let refused = registry
        .mint(claude())
        .expect("a refused account is minted");
    let removed = registry
        .mint(claude())
        .expect("a removed account is minted");
    clear_minted_mark(data_folder.path(), removed.account_id())
        .expect("the removed account carries no minted mark");
    mark_removed(data_folder.path(), removed.account_id(), &claude())
        .expect("the removed account carries a removed mark");
    let unmade = registry
        .mint(claude())
        .expect("an account whose home a stop left unmade");
    std::fs::remove_dir_all(unmade.home().path()).expect("the home is taken away");
    let admitted_mint = registry
        .mint(claude())
        .expect("an admitted account is minted");
    let admitted = registry
        .admit(
            &admitted_mint,
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
        .expect("the account is admitted");
    // A stop between the row's write and the mark's clear leaves the admitted home marked.
    mark_minted(data_folder.path(), &admitted.account_id, &claude())
        .expect("the admitted account is marked");
    let legs = Arc::new(RecordedSignOuts::refusing([refused.account_id().clone()]));

    LeftoverMintedHomes::read(&registry, data_folder.path().to_path_buf())
        .await
        .remove_unadmitted(
            &HashMap::from([(claude(), Arc::clone(&legs) as Arc<dyn ProviderAccountLegs>)]),
            Duration::from_secs(5),
        )
        .await;

    let mut signed_out: Vec<_> = legs.signed_out().into_iter().map(|(id, _)| id).collect();
    signed_out.sort();
    let mut expected = vec![stranded.account_id().clone(), refused.account_id().clone()];
    expected.sort();
    assert_eq!(signed_out, expected);
    assert!(
        !stranded.home().path().exists(),
        "the stranded home is removed"
    );
    assert!(
        refused.home().path().exists(),
        "a refused sign-out keeps its home"
    );
    assert!(
        removed.home().path().exists(),
        "a removed account's home stays"
    );
    assert!(
        admitted.credential_home.path().exists(),
        "the admitted home stays"
    );
    let still_marked: Vec<_> = read_minted_homes(data_folder.path())
        .expect("the homes are read")
        .into_iter()
        .map(|home| home.account_id)
        .collect();
    assert_eq!(still_marked, vec![refused.account_id().clone()]);
}
