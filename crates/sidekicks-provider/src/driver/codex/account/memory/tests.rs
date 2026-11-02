use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sidekicks_std::port_registration::PortRegistration;

use crate::account::memory_import::test_fixture::{Fixture, imported_count, snapshot, write};
use crate::account::registry::open_test_registry;
use crate::driver::codex::account::CodexAccountLegs;
use crate::driver::codex::rate_limits::CodexRateLimitFiling;
use crate::driver::codex::service::home::{CodexHomeKind, CodexServiceHome};
use crate::driver::codex::service::registry::{CodexServiceRegistry, OneHome, switching_home};
use crate::driver::codex::service::supervisor::test_service::{
    ScriptedCodexService, start_scripted_codex_service,
};
use crate::driver::contract::account::ProviderMemoryImportLegs;
use crate::driver::test_registry::NothingServed;

// The memory import's legs over a registry holding a scripted service, whose folders the service
// keeps, the person's own Codex folder `own`, and the switching home's folder of the store `store`.
async fn codex_legs(
    fixture: &Fixture,
    own: &Path,
    store: &str,
) -> (
    Arc<dyn ProviderMemoryImportLegs>,
    PathBuf,
    ScriptedCodexService,
) {
    let scripted = start_scripted_codex_service();
    let registry = CodexServiceRegistry::holding_on(
        &scripted,
        Arc::new(OneHome(CodexServiceHome {
            codex_home: own.to_path_buf(),
            kind: CodexHomeKind::PersonalFolder,
        })),
    );
    let accounts = Arc::new(PortRegistration::new("provider account registry"));
    let (account_registry, _writer) =
        open_test_registry(&fixture.database, fixture.data_folder.path()).await;
    assert!(accounts.register(Arc::new(account_registry)).is_ok());
    let legs: Arc<dyn ProviderMemoryImportLegs> = Arc::new(CodexAccountLegs::new(
        registry,
        Arc::clone(&scripted.dependencies),
        CodexRateLimitFiling::new(Arc::new(PortRegistration::new("usage"))),
        accounts,
        Arc::new(NothingServed),
    ));
    let switching = switching_home(&scripted.dependencies.data_folder).join(store);
    (legs, switching, scripted)
}

// Codex's own memories land in the account's home and in the switching home, each file counted
// once, a file the switching home already holds kept, and the person's own folder left as it was.
// Killed by the switching home left out, by a file counted per home, and by an overwrite there.
#[tokio::test]
async fn codex_memories_land_in_the_account_and_switching_homes_and_count_once() {
    let fixture = Fixture::new().await;
    let own = fixture.own_home.path().join(".codex");
    write(&own.join("memories/one.md"), b"one");
    write(&own.join("memories/two.md"), b"two");
    let (legs, switching, _scripted) = codex_legs(&fixture, &own, "memories").await;
    write(&switching.join("two.md"), b"another account's");
    let account = fixture.account("codex").await;
    let before = snapshot(&own);

    let outcome = fixture
        .import(&legs, &account)
        .await
        .expect("the memory is imported");

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

// A person on Codex's second memory store has it land in the second store of both homes, and
// neither home gains a first store, which would turn Codex there back to the first. Killed by the
// second store left out, and by its copy landing in the first store's folder.
#[tokio::test]
async fn codexs_second_memory_store_lands_in_the_second_store_of_both_homes() {
    let fixture = Fixture::new().await;
    let own = fixture.own_home.path().join(".codex");
    write(&own.join("memories_v2/one.md"), b"one");
    let (legs, switching, _scripted) = codex_legs(&fixture, &own, "memories_v2").await;
    let account = fixture.account("codex").await;

    let outcome = fixture
        .import(&legs, &account)
        .await
        .expect("the memory is imported");

    assert_eq!(imported_count(&outcome), Some(1));
    let home = account.credential_home.path();
    assert_eq!(
        fs::read(home.join("memories_v2/one.md")).expect("copied"),
        b"one"
    );
    assert_eq!(fs::read(switching.join("one.md")).expect("copied"), b"one");
    assert!(!home.join("memories").exists());
    assert!(
        !switching
            .parent()
            .expect("the store sits in the switching home")
            .join("memories")
            .exists()
    );
}
