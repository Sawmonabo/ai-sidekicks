//! A run's live binding: the newest binding row of a run that has not ended, which names the driver
//! a run-addressed handler acts through and the binding a run-addressed driver call names. A run
//! keeps every binding it had, so the older rows are the ones a resume or a rewind replaced.

use rusqlite::Connection;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use crate::provider::runtime_binding::store::{RuntimeBinding, read_run_bindings};
use crate::session::run::read::RunStateReader;

/// The statements live-binding reads prepare on a read connection: the run's row and its bindings.
#[expect(
    dead_code,
    reason = "the daemon's start sizes the read connections' statement caches with it"
)]
pub(crate) const LIVE_RUN_BINDINGS_STATEMENT_CAPACITY: usize = 2;

/// One run's live binding as the addressed session sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RunBindingResolution {
    /// No run of the addressed session answers to the id.
    UnknownRun {},
    /// The run has ended, or has no binding yet.
    NoLiveBinding {},
    /// The run's live binding.
    Bound {
        /// The provider the binding runs on.
        provider_name: ProviderId,
        /// The binding.
        binding_id: RuntimeBindingId,
    },
}

/// `run_id`'s live binding, read on `reader`, answering a run of another session as an unknown
/// one. Fails as the reads do.
#[expect(
    dead_code,
    reason = "a run-addressed driver call names the binding it acts on with it"
)]
pub(crate) fn resolve_run_binding(
    reader: &Connection,
    session_id: &SessionId,
    run_id: &RunId,
) -> rusqlite::Result<RunBindingResolution> {
    let Some(run) = RunStateReader::new(reader).read_run(run_id)? else {
        return Ok(RunBindingResolution::UnknownRun {});
    };
    if run.session_id != *session_id {
        return Ok(RunBindingResolution::UnknownRun {});
    }
    if run.state.is_terminal() {
        return Ok(RunBindingResolution::NoLiveBinding {});
    }
    Ok(match newest_binding(reader, run_id)? {
        Some(binding) => RunBindingResolution::Bound {
            provider_name: binding.provider_name,
            binding_id: binding.id,
        },
        None => RunBindingResolution::NoLiveBinding {},
    })
}

// The run's newest binding row; the rows read in the order they were written.
fn newest_binding(reader: &Connection, run_id: &RunId) -> rusqlite::Result<Option<RuntimeBinding>> {
    Ok(read_run_bindings(reader, run_id)?.pop())
}
