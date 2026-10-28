//! A shell's writes admitted in the order they came: decided at once under the lease's lock while
//! no change of holder is in flight, and otherwise kept in line until that change settles, so the
//! order in which waiting callers wake never reorders their writes.

use std::sync::Arc;

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::terminal::control::TerminalControlChangedReason;
use sidekicks_ipc::domain_error::DomainError;
use tokio::sync::oneshot;

use crate::control_lease::{
    DeviceHold, LeaseHolder, LeaseShared, LeaseState, ShellControlLease, ShellWriter, rejoin,
};

/// A write's admission: made at once, or waiting in line for the change of holder in flight.
pub(crate) enum WriteAdmission<T> {
    /// Admitted under the lease's lock, with what the write answered.
    Admitted(T),
    /// In line behind the change in flight, answered once it settles.
    Waiting(oneshot::Receiver<Result<T, DomainError>>),
}

impl<T> WriteAdmission<T> {
    /// What the write answered once admitted. Fails with the refusal it met in line or the failure
    /// of the take it waited on, and with `system.internalError` when the lease ended first.
    pub(crate) async fn admitted(self) -> Result<T, DomainError> {
        match self {
            Self::Admitted(answer) => Ok(answer),
            Self::Waiting(answered) => answered.await.unwrap_or_else(|_lease_ended| {
                Err(DomainError::new(
                    "the shell's lease ended before the write was admitted",
                    RefusalCode::SystemInternalError,
                ))
            }),
        }
    }
}

/// A write in line for the change of holder in flight.
pub(super) struct WaitingWrite {
    writer: ShellWriter,
    /// Whether the change in flight made its writer the holder, so that change's failure is its.
    is_joined: bool,
    /// Makes the write when admitted, or answers the refusal.
    admit: Box<dyn FnOnce(Result<(), DomainError>) + Send>,
}

/// What a write's check under the lease's lock leads to.
enum WriteDecision {
    /// Its writer holds the shell.
    Admit,
    /// Its writer may not write to the shell.
    Refuse(DomainError),
    /// Its device took the shell nobody held; the write waits for that take's broadcast.
    TakeStarted,
}

impl ShellControlLease {
    /// Hands one write to `write` under the lease's lock once its writer holds the shell, in the
    /// order the writes came: at once while no change of holder is in flight, otherwise after it
    /// settles. A device's write to a shell nobody holds takes it first and waits for the take's
    /// broadcast, failing with it; a holding connection's write binds the pane it came through.
    /// Refuses at once a device whose pane or shell ended, and otherwise a writer not holding the
    /// shell with `terminal.control.notHeld`, at once or once in line. `write` must not block: it
    /// hands the bytes to the terminal's intake, which keeps the order of the calls.
    pub(crate) fn admit_write<T: Send + 'static>(
        &self,
        writer: &ShellWriter,
        write: impl FnOnce() -> T + Send + 'static,
    ) -> Result<WriteAdmission<T>, DomainError> {
        let shared = &self.shared;
        let mut state = shared.lock();
        if state.pending.is_none() {
            match shared.decide_write(&mut state, writer) {
                WriteDecision::Admit => return Ok(WriteAdmission::Admitted(write())),
                WriteDecision::Refuse(refusal) => return Err(refusal),
                WriteDecision::TakeStarted => {}
            }
        } else if let ShellWriter::Device(caller) = writer {
            (shared.refuse_ended_caller)(caller)?;
        }
        let (answer, answered) = oneshot::channel();
        let is_joined = is_held_by(writer, state.holder.as_ref());
        state.waiting_writes.push_back(WaitingWrite {
            writer: writer.clone(),
            is_joined,
            admit: Box::new(move |admitted| {
                if answer.send(admitted.map(|()| write())).is_err() {
                    tracing::debug!("a shell write's caller stopped waiting for its admission");
                }
            }),
        });
        Ok(WriteAdmission::Waiting(answered))
    }
}

impl LeaseShared {
    /// Admits the writes that waited for the change that just settled, in the order they came,
    /// until one starts a take of its own; a `failure` of that change first fails the writes it
    /// made holders of. Called under the lease's lock with no change in flight.
    pub(super) fn admit_waiting_writes(
        self: &Arc<Self>,
        state: &mut LeaseState,
        failure: Option<&Arc<DomainError>>,
    ) {
        if let Some(failure) = failure {
            let (failed, kept) = state
                .waiting_writes
                .drain(..)
                .partition(|write| write.is_joined);
            state.waiting_writes = kept;
            for write in failed {
                (write.admit)(Err(rejoin(failure)));
            }
        }
        while state.pending.is_none()
            && let Some(write) = state.waiting_writes.pop_front()
        {
            match self.decide_write(state, &write.writer) {
                WriteDecision::Admit => (write.admit)(Ok(())),
                WriteDecision::Refuse(refusal) => (write.admit)(Err(refusal)),
                WriteDecision::TakeStarted => state.waiting_writes.push_front(write),
            }
        }
        for write in &mut state.waiting_writes {
            write.is_joined = is_held_by(&write.writer, state.holder.as_ref());
        }
    }

    /// Decides one write under the lease's lock with no change in flight.
    fn decide_write(
        self: &Arc<Self>,
        state: &mut LeaseState,
        writer: &ShellWriter,
    ) -> WriteDecision {
        if let ShellWriter::Device(caller) = writer
            && let Err(refusal) = (self.refuse_ended_caller)(caller)
        {
            return WriteDecision::Refuse(refusal);
        }
        if is_held_by(writer, state.holder.as_ref()) {
            if let (ShellWriter::Device(caller), Some(LeaseHolder::Device(hold))) =
                (writer, &mut state.holder)
            {
                // Typing in a pane keeps the hold through it as a take there would, announced by
                // nobody.
                hold.bind(caller);
            }
            return WriteDecision::Admit;
        }
        match (writer, &state.holder) {
            (ShellWriter::Device(caller), None) => {
                // The write waits in line for the take, which admits it once its broadcast settles.
                drop(self.change_holder(
                    state,
                    Some(LeaseHolder::Device(DeviceHold::of(caller))),
                    TerminalControlChangedReason::Taken,
                ));
                WriteDecision::TakeStarted
            }
            (ShellWriter::Device(_) | ShellWriter::Run(_), _) => {
                WriteDecision::Refuse(self.not_held())
            }
        }
    }
}

/// Whether `writer` holds the shell `holder` holds: a device through a connection bound to its
/// hold, a run as itself.
fn is_held_by(writer: &ShellWriter, holder: Option<&LeaseHolder>) -> bool {
    match (writer, holder) {
        (ShellWriter::Device(caller), Some(LeaseHolder::Device(hold))) => {
            hold.is_bound_to(&caller.connection)
        }
        (ShellWriter::Run(run_id), Some(LeaseHolder::Run(hold))) => hold.run_id == *run_id,
        (ShellWriter::Device(_) | ShellWriter::Run(_), _) => false,
    }
}
