use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_std::port_registration::PortRegistration;

use super::{CodexMemorySettings, CodexMemoryStore, resolve_codex_memory_store};
use crate::account::memory_import::test_fixture::{Fixture, imported_count, snapshot, write};
use crate::account::registry::open_test_registry;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome, switching_home};
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_terminal_service,
};
use crate::driver::contract::account::ProviderMemoryImportLegs;
use crate::driver::test_registry::NothingServed;

// Where a case's home stands: a home with no first store, one holding it, or a path no check of
// it can read.
#[derive(Clone, Copy)]
enum HomeFolder {
    WithoutFirstStore,
    WithFirstStore,
    Unreadable,
}

// Codex's own rule picks a home's store: a set version over everything else, else the second for a
// fresh home with the feature on and dual writes not off, else the first. A requirement's pin of
// the feature wins over the config's, and the legacy `memory_tool` over the feature's own key.
#[rstest]
// Killed by a set version ignored.
#[case::set_first(
    json!({"features": {"memories": true}, "memories": {"version": "v1"}}),
    None,
    HomeFolder::WithoutFirstStore,
    CodexMemoryStore::First
)]
// Killed by the folder or `dual_write` read over a set version.
#[case::set_second(
    json!({"memories": {"version": "v2", "dual_write": false}}),
    None,
    HomeFolder::WithFirstStore,
    CodexMemoryStore::Second
)]
// Killed by a fixed `memories/`.
#[case::fresh_home(
    json!({"features": {"memories": true}}),
    None,
    HomeFolder::WithoutFirstStore,
    CodexMemoryStore::Second
)]
// Killed by the second picked whatever stands.
#[case::first_store_stands(
    json!({"features": {"memories": true}}),
    None,
    HomeFolder::WithFirstStore,
    CodexMemoryStore::First
)]
// Killed by `dual_write = false` ignored.
#[case::dual_write_off(
    json!({"features": {"memories": true}, "memories": {"dual_write": false}}),
    None,
    HomeFolder::WithoutFirstStore,
    CodexMemoryStore::First
)]
// Killed by `dual_write` read as "must be unset".
#[case::dual_write_on(
    json!({"features": {"memories": true}, "memories": {"dual_write": true}}),
    None,
    HomeFolder::WithoutFirstStore,
    CodexMemoryStore::Second
)]
// Killed by the feature ignored.
#[case::feature_off(json!({}), None, HomeFolder::WithoutFirstStore, CodexMemoryStore::First)]
// Killed by a failed check read as "absent", failing open. A path holding a NUL byte fails the
// check before any system call, on every system.
#[case::check_fails(
    json!({"features": {"memories": true}}),
    None,
    HomeFolder::Unreadable,
    CodexMemoryStore::First
)]
// Killed by the requirements left unread, and by the config's switch read over a requirement's.
#[case::required_on(
    json!({"features": {"memories": false}}),
    Some(json!({"memories": true})),
    HomeFolder::WithoutFirstStore,
    CodexMemoryStore::Second
)]
// Killed by the legacy key ignored.
#[case::legacy_key_on(
    json!({"features": {"memory_tool": true}}),
    None,
    HomeFolder::WithoutFirstStore,
    CodexMemoryStore::Second
)]
// Killed by the feature's own key read over the legacy one, which Codex applies last.
#[case::legacy_key_wins_in_requirements(
    json!({}),
    Some(json!({"memories": false, "memory_tool": true})),
    HomeFolder::WithoutFirstStore,
    CodexMemoryStore::Second
)]
// Killed by a requirement that turns the feature off ignored where the config turns it on.
#[case::required_off(
    json!({"features": {"memories": true}}),
    Some(json!({"memories": false})),
    HomeFolder::WithoutFirstStore,
    CodexMemoryStore::First
)]
#[tokio::test]
async fn codex_picks_a_homes_memory_store_by_its_own_rule(
    #[case] config: Value,
    #[case] feature_requirements: Option<Value>,
    #[case] home_folder: HomeFolder,
    #[case] expected: CodexMemoryStore,
) {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let home = match home_folder {
        HomeFolder::WithoutFirstStore => scratch.path().to_path_buf(),
        HomeFolder::WithFirstStore => {
            let home = scratch.path().to_path_buf();
            fs::create_dir(home.join("memories")).expect("the first store is made");
            home
        }
        HomeFolder::Unreadable => scratch.path().join("memory\0home"),
    };
    let requirements = json!({
        "requirements": feature_requirements
            .map(|features| json!({"featureRequirements": features})),
    });
    let settings = CodexMemorySettings::read(config, requirements).expect("the settings read");

    assert_eq!(resolve_codex_memory_store(&home, settings).await, expected);
}

// The memory import's legs over a registry holding the scripted terminal service on the person's
// own Codex folder, which is that service's own home; answers the legs, the switching home, and
// the scripted service, whose connection the test answers.
async fn codex_legs(
    fixture: &Fixture,
) -> (
    Arc<dyn ProviderMemoryImportLegs>,
    PathBuf,
    ScriptedCodexService,
) {
    let scripted = start_scripted_terminal_service();
    let registry = CodexServiceRegistry::holding_on(
        &scripted,
        Arc::new(OneHome(scripted.service.home().clone())),
    );
    let accounts = Arc::new(PortRegistration::new("provider account registry"));
    let (account_registry, _writer) =
        open_test_registry(&fixture.database, fixture.data_folder.path()).await;
    assert!(accounts.register(Arc::new(account_registry)).is_ok());
    let legs: Arc<dyn ProviderMemoryImportLegs> = CodexAccountLegs::new(
        registry,
        Arc::clone(&scripted.dependencies),
        CodexRateLimitFiling::new(Arc::new(PortRegistration::new("usage"))),
        accounts,
        Arc::new(NothingServed),
        Arc::new(PortRegistration::new("account home lock")),
    );
    let switching = switching_home(&scripted.dependencies.data_folder);
    (legs, switching, scripted)
}

// Answers the import's config read on `scripted` with `config`, asserting it is Codex's config
// read for no project folder, then its requirements read with none set.
async fn answer_config_read(scripted: &mut ScriptedCodexService, config: &Value) {
    let config_read = scripted.script.next_sent().await;
    assert_eq!(config_read["method"], "config/read", "{config_read}");
    assert!(config_read["params"]["cwd"].is_null(), "{config_read}");
    scripted.script.answer(&config_read, config);
    let requirements_read = scripted.script.next_sent().await;
    assert_eq!(
        requirements_read["method"], "configRequirements/read",
        "{requirements_read}"
    );
    scripted
        .script
        .answer(&requirements_read, &json!({"requirements": null}));
}

// Codex's own memories land in the account's home and in the switching home, each file counted
// once, a file the switching home already holds kept, and the person's own folder left as it was.
// Killed by the switching home left out, by a file counted per home, by an overwrite there, and by
// a config read sent with a folder.
#[tokio::test(flavor = "multi_thread")]
async fn codex_memories_land_in_the_account_and_switching_homes_and_count_once() {
    let fixture = Fixture::new().await;
    let (legs, switching_home, mut scripted) = codex_legs(&fixture).await;
    let own = scripted.service.home().codex_home.clone();
    write(&own.join("memories/one.md"), b"one");
    write(&own.join("memories/two.md"), b"two");
    let switching = switching_home.join("memories");
    write(&switching.join("two.md"), b"another account's");
    let account = fixture.account("codex").await;
    let before = snapshot(&own);
    let config = json!({"config": {}, "origins": {}});

    let (outcome, ()) = tokio::join!(
        fixture.import(&legs, &account),
        answer_config_read(&mut scripted, &config),
    );
    let outcome = outcome.expect("the memory is imported");

    assert_eq!(snapshot(&own), before);
    assert_eq!(imported_count(&outcome), Some(2));
    let memories = account.credential_home.path().join("memories");
    assert_eq!(fs::read(memories.join("one.md")).expect("copied"), b"one");
    assert_eq!(fs::read(memories.join("two.md")).expect("copied"), b"two");
    assert_eq!(fs::read(switching.join("one.md")).expect("copied"), b"one");
    assert_eq!(
        fs::read(switching.join("two.md")).expect("kept"),
        b"another account's"
    );
}

// A person whose Codex settings name the second memory store, beside an old first store, has the
// second land in the second store of both homes, and neither home gains a first store, which would
// turn Codex there back to the first. Killed by the second store left out, by its copy landing in
// the first store's folder, by both stores copied by name (the old first store lands and turns both
// homes to the first), and by the store picked from the folders alone rather than Codex's settings.
#[tokio::test(flavor = "multi_thread")]
async fn codexs_second_memory_store_lands_in_the_second_store_of_both_homes() {
    let fixture = Fixture::new().await;
    let (legs, switching_home, mut scripted) = codex_legs(&fixture).await;
    let own = scripted.service.home().codex_home.clone();
    write(&own.join("memories/stale.md"), b"stale");
    write(&own.join("memories_v2/one.md"), b"one");
    let account = fixture.account("codex").await;
    let config = json!({"config": {"memories": {"version": "v2"}}, "origins": {}});

    let (outcome, ()) = tokio::join!(
        fixture.import(&legs, &account),
        answer_config_read(&mut scripted, &config),
    );
    let outcome = outcome.expect("the memory is imported");

    assert_eq!(imported_count(&outcome), Some(1));
    let home = account.credential_home.path();
    assert_eq!(
        fs::read(home.join("memories_v2/one.md")).expect("copied"),
        b"one"
    );
    assert_eq!(
        fs::read(switching_home.join("memories_v2/one.md")).expect("copied"),
        b"one"
    );
    assert!(!home.join("memories").exists());
    assert!(!switching_home.join("memories").exists());
}
