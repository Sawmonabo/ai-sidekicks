//! What the daemon reports each of its own children's life to, so that none outlives the daemon
//! unreaped: a terminal's shell, a Claude Code process and a Codex service on an account home, each
//! recorded as its intent before the start and its process after it, and retired once its reap sees
//! it end. The guard opens by sweeping what a previous run left, so the registry holds only this
//! run's children.

use std::error::Error;
use std::io;
use std::path::Path;

use futures::future::BoxFuture;
use sidekicks_platforms::{pin_child_process, process_identity};
use sidekicks_provider::driver::child_records::DaemonChildRecords;
use sidekicks_std::random_hex::random_hex;

use crate::orphan::registry::{OrphanRegistry, OrphanRegistryError};
use crate::orphan::sweep::{OrphanSweepInterrupted, OrphanSweepResult, sweep_orphans};

// The random bytes in a nonce, so no other process carries it by chance.
const NONCE_RANDOM_BYTES: usize = 16;

/// Why the guard could not open or record a child.
#[derive(Debug, thiserror::Error)]
pub enum OrphanGuardError {
    /// The registry could not be read or written.
    #[error(transparent)]
    Registry(#[from] OrphanRegistryError),
    /// The sweep of a previous run's children ended before it finished.
    #[error(transparent)]
    Sweep(#[from] OrphanSweepInterrupted),
    /// The boot or a started child could not be read.
    #[error("the daemon's boot or a started child of the daemon could not be read")]
    Process(#[source] io::Error),
    /// A nonce could not be drawn.
    #[error("a child's nonce could not be drawn")]
    Nonce(#[source] getrandom::Error),
}

/// Records each of the daemon's own children in the orphan registry across its life; whoever
/// reaps a child retires it when the reap sees it end.
pub struct OrphanGuard {
    registry: OrphanRegistry,
    boot_id: String,
}

impl DaemonChildRecords for OrphanGuard {
    fn prepare_spawn(&self) -> BoxFuture<'_, Result<String, Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            let nonce = random_hex(NONCE_RANDOM_BYTES).map_err(OrphanGuardError::Nonce)?;
            self.registry
                .record_intent(&nonce, &self.boot_id)
                .await
                .map_err(OrphanGuardError::Registry)?;
            Ok(nonce)
        })
    }

    fn complete_spawn<'call>(
        &'call self,
        nonce: &'call str,
        process_id: u32,
    ) -> BoxFuture<'call, Result<(), Box<dyn Error + Send + Sync>>> {
        Box::pin(async move {
            let record = pin_child_process(process_id)
                .and_then(|child| child.record())
                .map_err(OrphanGuardError::Process)?;
            let written = match record {
                Some(record) => self.registry.record_child(nonce, record).await,
                // The child has already ended, so there is nothing to record.
                None => self.registry.retire(nonce).await,
            };
            Ok(written.map_err(OrphanGuardError::Registry)?)
        })
    }

    fn retire<'call>(&'call self, nonce: &'call str) -> BoxFuture<'call, ()> {
        Box::pin(async move {
            if let Err(error) = self.registry.retire(nonce).await {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "The orphan registry could not forget an ended child of the daemon."
                );
            }
        })
    }
}

/// Sweeps what a previous run left in `data_folder`'s registry, empties it, logs what the sweep
/// did and answers a guard over it. Fails when this boot cannot be read, the sweep's task ends
/// early or the registry cannot be read or written.
pub async fn open_orphan_guard(data_folder: &Path) -> Result<OrphanGuard, OrphanGuardError> {
    let boot_id = process_identity(std::process::id())
        .map_err(OrphanGuardError::Process)?
        .ok_or_else(|| {
            OrphanGuardError::Process(io::Error::new(
                io::ErrorKind::NotFound,
                "the daemon's own process reads as ended",
            ))
        })?
        .boot_id
        .as_str()
        .to_owned();
    let registry = OrphanRegistry::new(data_folder);
    let sweep: OrphanSweepResult =
        sweep_orphans(registry.read_leftover().await?, boot_id.clone()).await?;
    registry.forget().await?;
    sweep.log();
    Ok(OrphanGuard { registry, boot_id })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use sidekicks_platforms::{
        CAN_BIND_A_SOCKET_LISTENER, CAN_LINK_A_SOCKET, pin_running_process, short_socket_folder,
    };
    use sidekicks_provider::driver::child_records::DaemonChildRecords;
    use sidekicks_provider::driver::test_registry::{
        CodexServicesBeside, serve_as_codex_stand_in, write_codex_stand_in_script,
    };

    use super::open_orphan_guard;

    /// The stand-in Codex service: this test program, run by the script the services start.
    const CODEX_SERVICE_STAND_IN: &str = "orphan::guard::tests::a_codex_service_stand_in";

    /// How long the test waits for the swept service to end.
    const END_WAIT: Duration = Duration::from_secs(10);

    #[tokio::test]
    #[ignore = "run only as the sweep test's Codex service"]
    async fn a_codex_service_stand_in() {
        serve_as_codex_stand_in().await;
    }

    // Fails when the service on an account home starts unrecorded, which leaves it running past the
    // next start's sweep, and when the lasting service is recorded, which the sweep then kills.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_next_start_ends_a_provider_child_and_leaves_the_lasting_service_running() {
        if !CAN_LINK_A_SOCKET || !CAN_BIND_A_SOCKET_LISTENER {
            return;
        }
        let folder = short_socket_folder().expect("a scratch folder is made");
        let data_folder = folder.path().join("daemon");
        std::fs::create_dir_all(&data_folder).expect("the data folder is made");
        let guard: Arc<dyn DaemonChildRecords> = Arc::new(
            open_orphan_guard(&data_folder)
                .await
                .expect("the guard opens"),
        );
        let script = write_codex_stand_in_script(folder.path(), CODEX_SERVICE_STAND_IN);
        let services = CodexServicesBeside::start(folder.path(), &script, &guard).await;

        // The next start's guard sweeps while every child of this one still runs, as after the
        // daemon died without draining them.
        open_orphan_guard(&data_folder)
            .await
            .expect("the next start's guard opens");
        let is_account_service_ended = match pin_running_process(services.account_process_id)
            .expect("the process table reads")
        {
            Some(process) => tokio::time::timeout(END_WAIT, process.wait_for_end())
                .await
                .is_ok_and(|ended| {
                    ended.expect("the process's end is watched");
                    true
                }),
            None => true,
        };
        let is_lasting_service_running = pin_running_process(services.lasting_process_id)
            .expect("the process table reads")
            .is_some();
        services.stop().await;

        assert!(
            is_account_service_ended,
            "the account home's service outlived the sweep"
        );
        assert!(
            is_lasting_service_running,
            "the sweep ended the lasting service"
        );
    }
}
