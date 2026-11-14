//! The provider services the daemon holds a connection to, known by the process serving each. A
//! provider service the person runs themselves sits outside the daemon's tree, so a command an
//! agent runs on it is known only as that process's descendant; a caller descending from any of
//! them is refused as one the daemon started is.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};

use sidekicks_platforms::{ProcessRecord, UnixDomainStream, unix_domain_peer_process};
use sidekicks_std::mutex_lock::lock;

/// Each serving process with the number of connections held to it.
type HoldCounts = Arc<Mutex<HashMap<u32, usize>>>;

/// Why the process serving a provider service connection could not be held.
#[derive(Debug, thiserror::Error)]
pub enum HoldServingError {
    /// The service closed its end before its process was read.
    #[error("the provider service closed its connection before its process was read")]
    PeerClosed,
    /// The system could not name the process at the other end.
    #[error("the provider service's process could not be read")]
    Read(#[source] io::Error),
}

/// The processes serving the provider service connections the daemon holds now.
#[derive(Default)]
pub struct ProviderServiceProcesses {
    /// Each serving process with its held connections; an entry goes with its last hold.
    holds: HoldCounts,
}

impl ProviderServiceProcesses {
    /// Holds the process serving the dialed `stream` until the returned hold drops, handing the
    /// stream back beside it, with the process's record where the system reads one. The system
    /// names the process from the socket, a read that can touch the process table, so it runs on
    /// the blocking pool. An error when the system cannot name the process, the service having
    /// closed its end included.
    pub async fn hold_serving(
        &self,
        stream: UnixDomainStream,
    ) -> Result<(UnixDomainStream, ProviderServiceHold), HoldServingError> {
        let (stream, read) = tokio::task::spawn_blocking(move || {
            let read = unix_domain_peer_process(&stream).map(|process| {
                process.map(|process| {
                    // A record the system cannot read leaves the process unnamed, which a reader
                    // takes for a process it has not met.
                    let record = process.record().unwrap_or_default();
                    (process.id(), record)
                })
            });
            (stream, read)
        })
        .await
        .map_err(|join_error| HoldServingError::Read(io::Error::other(join_error)))?;
        let (process_id, record) = read
            .map_err(HoldServingError::Read)?
            .ok_or(HoldServingError::PeerClosed)?;
        let mut hold = self.hold(process_id);
        hold.serving_process = record;
        Ok((stream, hold))
    }

    /// Counts the process with `process_id` as serving a held connection until the returned hold
    /// drops.
    pub(crate) fn hold(&self, process_id: u32) -> ProviderServiceHold {
        *lock(&self.holds).entry(process_id).or_default() += 1;
        ProviderServiceHold {
            holds: Arc::clone(&self.holds),
            process_id,
            serving_process: None,
        }
    }

    /// Whether the process with `process_id` serves a provider service connection the daemon
    /// holds.
    pub(crate) fn has(&self, process_id: u32) -> bool {
        lock(&self.holds).contains_key(&process_id)
    }

    /// Whether the daemon holds a connection to any provider service now.
    pub(crate) fn is_holding_any(&self) -> bool {
        !lock(&self.holds).is_empty()
    }
}

/// One held connection's serving process, counted until this drops.
#[must_use = "the process is held only while the hold lives"]
pub struct ProviderServiceHold {
    /// The counts this hold is one of.
    holds: HoldCounts,
    /// The process this hold counts.
    process_id: u32,
    /// The serving process's record, `None` where the system could not read it.
    serving_process: Option<ProcessRecord>,
}

impl ProviderServiceHold {
    /// The serving process's record: its id with its start, so a later dial tells the same
    /// process from a new one; `None` where the system could not read it.
    pub fn serving_process(&self) -> Option<&ProcessRecord> {
        self.serving_process.as_ref()
    }
}

impl Drop for ProviderServiceHold {
    fn drop(&mut self) {
        let mut holds = lock(&self.holds);
        let count = holds
            .get_mut(&self.process_id)
            .expect("a hold's process stays counted until the hold drops");
        *count -= 1;
        if *count == 0 {
            holds.remove(&self.process_id);
        }
    }
}
