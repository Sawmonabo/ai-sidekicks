//! What the terminal table reports each child's life to, so that no child outlives the daemon
//! unreaped: the intent before the start, the process after it, and the end the terminal's reap
//! sees. The guard opens by sweeping what a previous run left, so the registry holds only this
//! run's children.

use std::io;
use std::path::Path;

use sidekicks_platforms::{pin_child_process, process_identity};

use crate::orphan::registry::{OrphanRegistry, OrphanRegistryError};
use crate::orphan::sweep::{OrphanSweepInterrupted, OrphanSweepResult, sweep_orphans};
use sidekicks_std::random_hex::random_hex;

// The random bytes in a nonce, so no other process carries it by chance.
const NONCE_RANDOM_BYTES: usize = 16;

/// Why the guard could not open or record a child.
#[derive(Debug, thiserror::Error)]
pub(crate) enum OrphanGuardError {
    /// The registry could not be read or written.
    #[error(transparent)]
    Registry(#[from] OrphanRegistryError),
    /// The sweep of a previous run's children ended before it finished.
    #[error(transparent)]
    Sweep(#[from] OrphanSweepInterrupted),
    /// The boot or a started child could not be read.
    #[error("the daemon's boot or a started terminal child could not be read")]
    Process(#[source] io::Error),
    /// A nonce could not be drawn.
    #[error("a terminal child's nonce could not be drawn")]
    Nonce(#[source] getrandom::Error),
}

/// Records each terminal child in the orphan registry across its life; the terminal table retires
/// it when its reap sees it end.
pub(crate) struct OrphanGuard {
    registry: OrphanRegistry,
    boot_id: String,
}

impl OrphanGuard {
    /// Durably records that a child is about to start, and answers the nonce its environment must
    /// carry. Fails when the nonce cannot be drawn or the registry written.
    pub(crate) async fn prepare_spawn(&self) -> Result<String, OrphanGuardError> {
        let nonce = random_hex(NONCE_RANDOM_BYTES).map_err(OrphanGuardError::Nonce)?;
        self.registry.record_intent(&nonce, &self.boot_id).await?;
        Ok(nonce)
    }

    /// Records the started child `process_id`, the daemon's own child, under `nonce`. Fails when
    /// it cannot record it, and the caller then ends the child, so no child runs unrecorded.
    pub(crate) async fn complete_spawn(
        &self,
        nonce: &str,
        process_id: u32,
    ) -> Result<(), OrphanGuardError> {
        let record = pin_child_process(process_id)
            .and_then(|child| child.record())
            .map_err(OrphanGuardError::Process)?;
        match record {
            Some(record) => Ok(self.registry.record_child(nonce, record).await?),
            // The child has already ended, so there is nothing to record.
            None => Ok(self.registry.retire(nonce).await?),
        }
    }

    /// Forgets a child that has ended. A failed write goes to the service log; the next start's
    /// sweep finds the entry's child gone.
    pub(crate) async fn retire(&self, nonce: &str) {
        if let Err(error) = self.registry.retire(nonce).await {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "The orphan registry could not forget an ended terminal child."
            );
        }
    }
}

/// Sweeps what a previous run left in `data_folder`'s registry, empties it, logs what the sweep
/// did and answers a guard over it. Fails when this boot cannot be read, the sweep's task ends
/// early or the registry cannot be read or written.
pub(crate) async fn open_orphan_guard(data_folder: &Path) -> Result<OrphanGuard, OrphanGuardError> {
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
