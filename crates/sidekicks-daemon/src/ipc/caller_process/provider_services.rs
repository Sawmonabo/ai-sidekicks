//! The provider services the daemon holds a connection to, known by the process serving each. A
//! provider service the person runs themselves sits outside the daemon's tree, so a command an
//! agent runs on it is known only as that process's descendant; a caller descending from any of
//! them is refused as one the daemon started is.

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex, PoisonError};

use interprocess::local_socket::tokio::Stream;

use crate::ipc::caller_process::contract::CallerProcessReader;

/// Each serving process with the number of connections held to it.
type HoldCounts = Arc<Mutex<HashMap<u32, usize>>>;

/// Why the process serving a provider service connection could not be held.
#[derive(Debug, thiserror::Error)]
pub(crate) enum HoldServingError {
    /// The service closed its end before its process was read.
    #[error("the provider service closed its connection before its process was read")]
    PeerClosed,
    /// The system could not name the process at the other end.
    #[error("the provider service's process could not be read")]
    Read(#[source] io::Error),
}

/// The processes serving the provider service connections the daemon holds now.
pub(crate) struct ProviderServiceProcesses {
    /// Reads the process at the other end of a connection.
    reader: Arc<dyn CallerProcessReader>,
    /// Each serving process with its held connections; an entry goes with its last hold.
    holds: HoldCounts,
}

impl ProviderServiceProcesses {
    /// Processes known through `reader`, none held yet.
    pub(crate) fn new(reader: Arc<dyn CallerProcessReader>) -> Self {
        Self {
            reader,
            holds: Arc::default(),
        }
    }

    /// Holds the process serving the dialed `stream` until the returned hold drops. An error when
    /// the system cannot name the process, the service having closed its end included.
    pub(crate) fn hold_serving(
        &self,
        stream: &Stream,
    ) -> Result<ProviderServiceHold, HoldServingError> {
        let process_id = self
            .reader
            .read_peer_process(stream)
            .map_err(HoldServingError::Read)?
            .ok_or(HoldServingError::PeerClosed)?
            .id();
        *self
            .holds
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(process_id)
            .or_default() += 1;
        Ok(ProviderServiceHold {
            holds: Arc::clone(&self.holds),
            process_id,
        })
    }

    /// Whether the process with `process_id` serves a provider service connection the daemon
    /// holds.
    pub(crate) fn has(&self, process_id: u32) -> bool {
        self.holds
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(&process_id)
    }
}

/// One held connection's serving process, counted until this drops.
#[must_use = "the process is held only while the hold lives"]
pub(crate) struct ProviderServiceHold {
    /// The counts this hold is one of.
    holds: HoldCounts,
    /// The process this hold counts.
    process_id: u32,
}

impl Drop for ProviderServiceHold {
    fn drop(&mut self) {
        let mut holds = self.holds.lock().unwrap_or_else(PoisonError::into_inner);
        let count = holds
            .get_mut(&self.process_id)
            .expect("a hold's process stays counted until the hold drops");
        *count -= 1;
        if *count == 0 {
            holds.remove(&self.process_id);
        }
    }
}
