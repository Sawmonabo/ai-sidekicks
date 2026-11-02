use std::path::Path;

use crate::account::memory_import::copy_store;
use crate::account::memory_import::test_fixture::write;
use crate::driver::contract::account::MemoryImportStore;
use crate::driver::diagnostics::RecordedEvents;

// A memory file the account's home already has is kept and logged by its path from the folder
// the store lands in, never by a path that names where the home is. Killed by the kept entry
// logged by its whole path.
#[test]
fn a_kept_memory_file_is_logged_without_the_homes_path() {
    let scratch = tempfile::tempdir().expect("a scratch folder is made");
    let source = scratch.path().join("own/memories");
    let home = scratch.path().join("accounts/home");
    write(&source.join("one.md"), b"the person's");
    write(&home.join("memories/one.md"), b"the home's");
    let store = MemoryImportStore {
        source,
        destinations: vec![home.join("memories")],
    };
    let recorded = RecordedEvents::default();

    recorded.record_during(|| {
        assert_eq!(copy_store(&store).expect("the store is copied"), 0);
    });

    let texts = recorded.texts();
    let kept = Path::new("memories").join("one.md").display().to_string();
    assert!(texts.iter().any(|text| *text == kept), "{texts:?}");
    let home_path = home.display().to_string();
    assert!(
        texts.iter().all(|text| !text.contains(&home_path)),
        "{texts:?}"
    );
}
