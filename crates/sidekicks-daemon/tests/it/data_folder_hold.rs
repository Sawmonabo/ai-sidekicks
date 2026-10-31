//! The service's hold on its data folder, run as the daemon's own program: a second start on a
//! folder another service holds fails naming the holder, before it writes anything there.

use sidekicks_platforms::create_missing_private_folders;
use sidekicks_store::data_folder::lock::DataFolderLock;
use sidekicks_store::data_folder::{data_folder, service_log_folder};

use crate::helpers::{run_service, short_home};

// The test holds the folder as the first service does, so the start names the test's process and
// writes no line where the first service's log goes. Killed by taking the hold after the service
// log opens.
#[tokio::test]
async fn a_start_on_a_held_data_folder_fails_naming_the_holder_and_writes_nothing_there() {
    let home = short_home();
    let data_folder = data_folder(home.path());
    create_missing_private_folders(&data_folder).expect("the data folder is made");
    let _holder = DataFolderLock::take(&data_folder).expect("the test holds the data folder");

    let ended = run_service(home.path()).await;

    let standard_error = String::from_utf8_lossy(&ended.stderr);
    assert_eq!(ended.status.code(), Some(1), "{standard_error}");
    assert!(
        standard_error.contains(&format!(
            "The background service is already running (process {}).",
            std::process::id()
        )),
        "{standard_error}"
    );
    assert!(
        !service_log_folder(&data_folder).exists(),
        "the second start opened a service log"
    );
}
