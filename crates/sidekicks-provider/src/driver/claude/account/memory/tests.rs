use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_store::data_folder::agent_memory_folder;

use crate::account::memory_import::MemoryImportError;
use crate::account::memory_import::test_fixture::{Fixture, imported_count, snapshot, write};
use crate::driver::claude::account::test_account_legs;
use crate::driver::contract::account::ProviderMemoryImportLegs;
use crate::driver::test_registry::test_driver_services;

// Claude Code's legs reading the person's own configuration folder through the environment's
// `CLAUDE_CONFIG_DIR`, as the person's own Claude Code reads it.
fn claude_legs(fixture: &Fixture) -> Arc<dyn ProviderMemoryImportLegs> {
    let mut services = test_driver_services();
    services.data_folder = fixture.data_folder.path().to_owned();
    services.home_folder = fixture.own_home.path().to_owned();
    services.base_environment = Arc::from([(
        "CLAUDE_CONFIG_DIR".to_owned(),
        claude_folder(fixture).display().to_string(),
    )]);
    Arc::new(test_account_legs(&services))
}

fn claude_folder(fixture: &Fixture) -> PathBuf {
    fixture.own_home.path().join(".claude")
}

// Each project's memory lands in the same project folder of the account's home and each agent's
// notes in the daemon's one agent-memory folder, the outcome counting each file and kept on the
// row, while the person's own folder reads byte for byte as before. Killed by a copy back (the
// home's own note would appear in the person's folder), by any write under the person's folder,
// and by a project's conversation file copied as memory.
#[tokio::test]
async fn the_person_s_own_store_is_byte_identical_after_the_import_and_nothing_is_copied_back() {
    let fixture = Fixture::new().await;
    let own = claude_folder(&fixture);
    write(&own.join("projects/-work-app/memory/MEMORY.md"), b"index");
    write(
        &own.join("projects/-work-app/memory/topics/build.md"),
        b"build notes",
    );
    write(&own.join("projects/-work-app/session.jsonl"), b"{}");
    write(&own.join("projects/-work-other/session.jsonl"), b"{}");
    write(&own.join("agent-memory/reviewer/notes.md"), b"review notes");
    let account = fixture.account("claude").await;
    let home = account.credential_home.path().to_owned();
    write(
        &home.join("projects/-work-app/memory/account-only.md"),
        b"the account's",
    );
    let before = snapshot(&own);

    let outcome = fixture
        .import(&claude_legs(&fixture), &account)
        .await
        .expect("the memory is imported");

    assert_eq!(snapshot(&own), before);
    assert_eq!(imported_count(&outcome), Some(3));
    let project_memory = home.join("projects/-work-app/memory");
    assert_eq!(
        fs::read(project_memory.join("MEMORY.md")).expect("copied"),
        b"index"
    );
    assert_eq!(
        fs::read(project_memory.join("topics/build.md")).expect("copied"),
        b"build notes"
    );
    assert!(!home.join("projects/-work-app/session.jsonl").exists());
    assert!(!home.join("projects/-work-other").exists());
    assert_eq!(
        fs::read(agent_memory_folder(fixture.data_folder.path()).join("reviewer/notes.md"))
            .expect("copied"),
        b"review notes"
    );
    let stored = fixture
        .registry()
        .read(account.account_id.clone())
        .await
        .expect("the account reads");
    assert_eq!(stored.memory_import, Some(outcome));
}

// A second import of the account is refused and copies nothing, even a memory written since the
// first, and the first outcome stays on the row. Killed by the outcome left unrecorded, which lets
// the second import run and copy the new memory.
#[tokio::test]
async fn a_second_import_is_refused_and_copies_nothing() {
    let fixture = Fixture::new().await;
    let own = claude_folder(&fixture);
    write(&own.join("projects/-work-app/memory/MEMORY.md"), b"index");
    let account = fixture.account("claude").await;
    let legs = claude_legs(&fixture);
    let first = fixture
        .import(&legs, &account)
        .await
        .expect("the first import runs");
    write(
        &own.join("projects/-work-app/memory/later.md"),
        b"written since",
    );

    let second = fixture.import(&legs, &account).await;

    assert!(
        matches!(second, Err(MemoryImportError::AlreadyImported)),
        "{second:?}"
    );
    let home = account.credential_home.path();
    assert!(!home.join("projects/-work-app/memory/later.md").exists());
    let stored = fixture
        .registry()
        .read(account.account_id.clone())
        .await
        .expect("the account reads");
    assert_eq!(stored.memory_import, Some(first));
}

// A note already in the daemon's agent-memory folder is kept as it is and not counted, while the
// agent's other notes are copied beside it. Killed by an overwrite, which puts the person's bytes
// in place of the folder's own.
#[tokio::test]
async fn a_file_already_in_the_agent_memory_folder_is_kept() {
    let fixture = Fixture::new().await;
    let own = claude_folder(&fixture);
    write(&own.join("agent-memory/reviewer/notes.md"), b"the person's");
    write(&own.join("agent-memory/reviewer/style.md"), b"style");
    let account = fixture.account("claude").await;
    let shared = agent_memory_folder(fixture.data_folder.path());
    write(&shared.join("reviewer/notes.md"), b"the agent's own");

    let outcome = fixture
        .import(&claude_legs(&fixture), &account)
        .await
        .expect("the memory is imported");

    assert_eq!(
        fs::read(shared.join("reviewer/notes.md")).expect("kept"),
        b"the agent's own"
    );
    assert_eq!(
        fs::read(shared.join("reviewer/style.md")).expect("copied"),
        b"style"
    );
    assert_eq!(imported_count(&outcome), Some(1));
}
