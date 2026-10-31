//! The capability read on the scratch home the daemon owns.

use sidekicks_platforms::short_socket_folder;

use super::driver_on_codex_folder;
use crate::driver::codex::service::registry::capability_read_home;
use crate::driver::daemon_stop::DaemonStopIntent;

// Killed by removing the scratch home only after a read that succeeded: the read here fails, its
// Codex exiting at once, and the folder it ran in would stay behind with what the service wrote.
#[tokio::test]
async fn a_failed_capability_read_leaves_no_scratch_home() {
    let folder = short_socket_folder().expect("a scratch folder is made");
    let (driver, services) = driver_on_codex_folder(folder.path());

    let read = driver.get_capabilities().await;
    driver.shutdown(DaemonStopIntent::Stop).await;

    assert!(read.is_err());
    assert!(!capability_read_home(&services.data_folder).exists());
}
