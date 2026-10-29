use std::borrow::Cow;
use std::error::Error;

use sidekicks_contracts::provider::account::record::{
    BillingMode, CredentialGeneration, ProviderAccountHealthState, ProviderAccountId,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement};
use sidekicks_store::database::writer::test_file::TestDatabase;

use super::{
    AccountAdmission, HealthObservation, HealthObserver, ProviderAccountRegistry,
    RegisteredAccount, open_test_registry,
};
use crate::account::errors::ProviderAccountRegistryError;
use crate::driver::schema::schema_parts;

fn provider(id: &str) -> ProviderId {
    ProviderId::new(id.to_owned()).expect("a test provider id")
}

fn observation(state: ProviderAccountHealthState) -> HealthObservation {
    HealthObservation {
        state,
        observed_at: WireInstant::now(),
    }
}

/// Mints a `provider_id` account and admits it signed in.
pub(crate) async fn register(
    registry: &ProviderAccountRegistry,
    provider_id: &str,
) -> RegisteredAccount {
    let minted = registry
        .mint(provider(provider_id))
        .expect("the account is minted");
    registry
        .admit(
            &minted,
            &AccountAdmission {
                display_label: None,
                billing_mode: BillingMode::Subscription,
                health: observation(ProviderAccountHealthState::Authenticated),
                observed_auth_mode: None,
            },
        )
        .await
        .expect("the account is admitted")
}

fn generation(value: u64) -> CredentialGeneration {
    serde_json::from_value(value.into()).expect("a test generation")
}

// A probe crossing into or out of being signed in raises the generation by one, a same-state
// probe leaves it, a background crossing either way stores the reading and leaves it, and a write
// that fails keeps neither the reading nor the rise. Killed by the rise applied to the background
// observer, and by the rise and the reading split across writes.
#[tokio::test]
async fn only_a_probe_crossing_moves_the_generation_and_a_failed_write_keeps_nothing() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let (registry, writer) = open_test_registry(&database, data_folder.path()).await;
    let account = register(&registry, "claude").await;
    let id = &account.account_id;
    assert_eq!(account.credential_generation, generation(1));

    let steps = [
        (
            ProviderAccountHealthState::ReauthRequired,
            HealthObserver::Background,
            1,
        ),
        (
            ProviderAccountHealthState::Authenticated,
            HealthObserver::Background,
            1,
        ),
        (
            ProviderAccountHealthState::ReauthRequired,
            HealthObserver::Probe,
            2,
        ),
        (
            ProviderAccountHealthState::ReauthRequired,
            HealthObserver::Probe,
            2,
        ),
        (
            ProviderAccountHealthState::Indeterminate,
            HealthObserver::Probe,
            2,
        ),
        (
            ProviderAccountHealthState::Authenticated,
            HealthObserver::Probe,
            3,
        ),
    ];
    for (state, observer, expected) in steps {
        let seen = observation(state);
        let stored = registry
            .record_health(id, &seen, observer)
            .await
            .expect("the reading is stored");
        assert_eq!(stored, generation(expected), "{state:?} by {observer:?}");
        let read = registry.read(id.clone()).await.expect("the account reads");
        assert_eq!(read.health, Some(seen));
        assert_eq!(read.credential_generation, generation(expected));
    }
    let before = registry.read(id.clone()).await.expect("the account reads");

    writer
        .write(vec![statement(
            "CREATE TRIGGER forced_failure BEFORE UPDATE OF health_state ON provider_accounts
             BEGIN SELECT RAISE(ABORT, 'forced'); END",
        )])
        .await
        .expect("the failing trigger is made");
    let failed = registry
        .record_health(
            id,
            &observation(ProviderAccountHealthState::ReauthRequired),
            HealthObserver::Probe,
        )
        .await;
    assert!(matches!(
        failed,
        Err(ProviderAccountRegistryError::Write(_))
    ));
    assert_eq!(
        registry.read(id.clone()).await.expect("the account reads"),
        before
    );
}

fn statement(sql: &'static str) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::None,
        expected_row_count: None,
    }
}

// Two handovers of one provider sent together both succeed and leave exactly one current
// account, the one written last. Killed by the mark set before the old one is cleared, which the
// one-current index refuses.
#[tokio::test]
async fn concurrent_handovers_leave_one_current_account() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
    let first = register(&registry, "claude").await;
    let second = register(&registry, "claude").await;
    let third = register(&registry, "claude").await;
    let other_provider = register(&registry, "codex").await;
    assert!(first.is_default && !second.is_default && !third.is_default);

    let (to_second, to_third) = tokio::join!(
        registry.make_current(second.account_id.clone()),
        registry.make_current(third.account_id.clone()),
    );
    to_second.expect("the first handover lands");
    to_third.expect("the second handover lands");

    let current: Vec<ProviderAccountId> = registry
        .list(Some(provider("claude")))
        .await
        .expect("the accounts read")
        .into_iter()
        .filter(|account| account.is_default)
        .map(|account| account.account_id)
        .collect();
    assert_eq!(current, vec![third.account_id]);
    let other = registry
        .read(other_provider.account_id)
        .await
        .expect("the other provider's account reads");
    assert!(
        other.is_default,
        "another provider's current account is untouched"
    );
}

// Every admitted account's home is the folder minted for its id under the data folder, absolute
// and present, never a provider's own folder. Killed by a home taken from anywhere but the mint.
#[tokio::test]
async fn every_registered_home_is_the_one_minted_under_the_data_folder() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
    register(&registry, "claude").await;
    register(&registry, "codex").await;

    let accounts = registry.list(None).await.expect("the accounts read");
    assert_eq!(accounts.len(), 2);
    for account in accounts {
        let home = account.credential_home.path();
        let minted = data_folder
            .path()
            .join("accounts")
            .join(account.account_id.as_str());
        assert_eq!(home, minted);
        assert!(home.is_absolute() && home.is_dir());
    }
}

// No refusal or failure the registry answers, and no account it prints, names a home's path:
// not in a reply's message or detail, not in the failure kept for the log. Killed by a message or
// a `Debug` that prints the home.
#[tokio::test]
async fn no_refusal_or_printed_account_carries_a_home_path() {
    let database = TestDatabase::new(schema_parts());
    let data_folder = tempfile::tempdir().expect("a data folder");
    let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
    let account = register(&registry, "claude").await;
    let home = account
        .credential_home
        .path()
        .to_string_lossy()
        .into_owned();
    let minted = registry
        .mint(provider("claude"))
        .expect("a second account is minted");
    let minted_home = minted.home().path().to_string_lossy().into_owned();

    let unknown = ProviderAccountId::new("unknown".to_owned()).expect("a test account id");
    let not_found = registry
        .make_current(unknown)
        .await
        .expect_err("an unknown account is refused");
    let full_folder = tempfile::tempdir().expect("a data folder whose homes folder is a file");
    std::fs::write(full_folder.path().join("accounts"), b"").expect("the file is made");
    let (blocked, _blocked_writer) = open_test_registry(&database, full_folder.path()).await;
    let unmade = blocked
        .mint(provider("claude"))
        .expect_err("a home under a file cannot be made");
    assert!(matches!(
        unmade,
        ProviderAccountRegistryError::CredentialHome(_)
    ));

    let mut printed = vec![format!("{account:?}"), format!("{minted:?}")];
    for error in [not_found, unmade] {
        match HandlerError::from(error) {
            HandlerError::Refused(refusal) => {
                printed.push(refusal.message.clone());
                printed.push(serde_json::to_string(&refusal.detail).expect("detail writes"));
                printed.push(format!("{refusal:?}"));
                printed.extend(error_chain(&refusal));
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }
    let blocked_folder = full_folder.path().to_string_lossy().into_owned();
    for text in printed {
        for path in [&home, &minted_home, &blocked_folder] {
            assert!(!text.contains(path.as_str()), "{text:?} names {path}");
        }
    }
}

fn error_chain(error: &(dyn Error + 'static)) -> Vec<String> {
    let mut chain = Vec::new();
    let mut current = Some(error);
    while let Some(error) = current {
        chain.push(error.to_string());
        chain.push(format!("{error:?}"));
        current = error.source();
    }
    chain
}
