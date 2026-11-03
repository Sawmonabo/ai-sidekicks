use std::path::PathBuf;
use std::sync::{Arc, Weak};

use sha2::{Digest as _, Sha256};
use sidekicks_contracts::provider::account::record::{BillingMode, ProviderAccountHealthState};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_platforms::{KeychainSignIn, sign_in_move};
use sidekicks_store::database::writer::test_file::TestDatabase;
use tempfile::TempDir;

use super::remove_claude_sign_in_move_leftovers;
use crate::account::homes::query_account_homes;
use crate::account::registry::{
    AccountAdmission, HealthObservation, ProviderAccountRegistry, RegisteredAccount,
    open_test_registry,
};
use crate::account::resolver::credential_home_folders;
use crate::driver::claude::account::credentials::claude_keychain_service;
use crate::driver::claude::account::test_account_legs;
use crate::driver::claude::spawn::environment::{ClaudeAccountFolders, ClaudeProcessHome};
use crate::driver::schema::schema_parts;
use crate::driver::test_registry::test_driver_services;
use crate::driver::{DriverServices, HelperModeServices, PROVIDER_REGISTRATIONS};

// The bytes of every planted file carry this.
const PLANTED_SECRET: &str = "planted-sign-in-secret";

// The user name every Claude Code process of the test runs as, which names its keychain item.
const USER: &str = "person";

struct Fixture {
    _data_folder: TempDir,
    _own_home: TempDir,
    database: TestDatabase,
    registry: ProviderAccountRegistry,
    services: DriverServices,
}

impl Fixture {
    async fn new() -> Self {
        let data_folder = tempfile::tempdir().expect("the data folder is made");
        let own_home = tempfile::tempdir().expect("the person's own home is made");
        let database = TestDatabase::new(schema_parts());
        let (registry, _writer) = open_test_registry(&database, data_folder.path()).await;
        let mut services = test_driver_services();
        services.data_folder = data_folder.path().to_owned();
        services.home_folder = own_home.path().to_owned();
        services.base_environment = Arc::from([
            ("HOME".to_owned(), own_home.path().display().to_string()),
            ("USER".to_owned(), USER.to_owned()),
        ]);
        Self {
            _data_folder: data_folder,
            _own_home: own_home,
            database,
            registry,
            services,
        }
    }

    // The bundle a helper mode builds, over what the driver's services hold.
    fn helper_mode_services(&self) -> HelperModeServices {
        HelperModeServices {
            data_folder: self.services.data_folder.clone(),
            base_environment: Arc::clone(&self.services.base_environment),
            reserved_names: Arc::clone(&self.services.reserved_names),
        }
    }

    async fn account(&self, provider: ProviderId) -> RegisteredAccount {
        let minted = self.registry.mint(provider).expect("the account is minted");
        self.registry
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
}

fn claude() -> ProviderId {
    ProviderId::new("claude".to_owned()).expect("the Claude Code provider id")
}

fn codex() -> ProviderId {
    ProviderId::new("codex".to_owned()).expect("the Codex provider id")
}

fn store_folder(account: &RegisteredAccount) -> PathBuf {
    account.credential_home.path().join("store")
}

// With no pool, every account home is listed, and the legs each registration builds for a helper
// mode name a Claude Code account's sign-in by the item its store folder salts under the user it
// runs as, the very item a session's composition on that home names, and name no Codex sign-in.
// Killed by the configuration folder salted in place of the store folder, by a composition of the
// names that drifts from a session's, and by a Codex account named.
#[tokio::test]
async fn the_helper_mode_names_each_claude_code_sign_in_and_no_codex_one() {
    let fixture = Fixture::new().await;
    let claude_account = fixture.account(claude()).await;
    let codex_account = fixture.account(codex()).await;
    let services = fixture.helper_mode_services();

    let homes = query_account_homes(&fixture.database.reader()).expect("the homes are listed");
    let mut named: Vec<(String, Option<KeychainSignIn>)> = homes
        .iter()
        .map(|home| {
            let registration = PROVIDER_REGISTRATIONS
                .iter()
                .find(|registration| registration.descriptor.id == home.provider)
                .expect("the account's provider is registered");
            let folders = home.folders().expect("the row names a provider");
            let sign_in = (registration.helper_mode_account_legs)(&services)
                .keychain_sign_in(&folders)
                .expect("the names are composed");
            (home.account_id.clone(), sign_in)
        })
        .collect();
    named.sort_by(|left, right| left.0.cmp(&right.0));

    let store = store_folder(&claude_account);
    let salt = Sha256::digest(store.display().to_string().as_bytes());
    let claude_sign_in = KeychainSignIn {
        service: format!(
            "Claude Code-credentials-{}",
            &base16ct::lower::encode_string(&salt)[..8]
        ),
        account: USER.to_owned(),
        file: store.join(".credentials.json"),
    };
    let mut expected = vec![
        (
            claude_account.account_id.as_str().to_owned(),
            Some(claude_sign_in.clone()),
        ),
        (codex_account.account_id.as_str().to_owned(), None),
    ];
    expected.sort_by(|left, right| left.0.cmp(&right.0));
    assert_eq!(named, expected);

    let session_environment = test_account_legs(&fixture.services, Weak::new())
        .compose_environment_on(
            ClaudeProcessHome::Account {
                folders: &ClaudeAccountFolders::from(&credential_home_folders(
                    &claude_account.provider,
                    &claude_account.credential_home,
                )),
            },
            &[],
        )
        .expect("a session's environment is composed");
    assert_eq!(
        claude_sign_in.service,
        claude_keychain_service(&session_environment)
    );
}

// The start's sweep removes the leftover a move stopped mid-write left beside a Claude Code
// account's sign-in file, and leaves the same name in a Codex account's home. Killed by a sweep
// that misses the store folder, and by one over every provider's accounts.
#[tokio::test]
async fn the_start_sweeps_a_stopped_moves_leftover() {
    let fixture = Fixture::new().await;
    let claude_account = fixture.account(claude()).await;
    let codex_account = fixture.account(codex()).await;
    let leftover_name = ".credentials.json.a1b2c3.tmp";
    let claude_leftover = store_folder(&claude_account).join(leftover_name);
    let codex_leftover = store_folder(&codex_account).join(leftover_name);
    for leftover in [&claude_leftover, &codex_leftover] {
        std::fs::create_dir_all(leftover.parent().expect("a leftover has a folder"))
            .expect("the store folder is made");
        std::fs::write(leftover, PLANTED_SECRET).expect("the leftover is written");
    }

    let failures = remove_claude_sign_in_move_leftovers(&fixture.registry)
        .await
        .expect("the sweep runs");

    assert!(failures.is_empty(), "{failures:?}");
    assert_eq!(claude_leftover.exists(), sign_in_move().is_none());
    assert!(codex_leftover.exists(), "a Codex account's file stays");
}
