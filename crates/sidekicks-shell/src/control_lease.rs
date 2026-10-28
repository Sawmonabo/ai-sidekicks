//! One shell's control lease: who may write to it, size it and close it.
//!
//! The lease is held by one of the person's devices, or by an agent's run on this machine, and
//! lives only in this daemon's memory. Beside that holder it keeps bindings: for a device, each
//! pane output subscription it was taken or written through, with the connection that subscription
//! belongs to; for a run, the command it last took it for and the device hold it took it from. Only
//! a bound connection writes to or sizes a device's shell, and each further pane it takes or writes
//! through is bound too; another connection of that device binds by taking it. A device takes a
//! shell nobody holds by taking it or by writing to it. No verb gives a shell back: a connection or
//! pane subscription closing ends its bindings, and a device's hold ends with the last of them or
//! when another device takes it; a run's hold ends when the command it holds the shell for ends or
//! the run leaves its running state, whichever comes first. A run's hold is never taken by a
//! device, forced or not. A run may take a shell a device holds; the lease keeps that hold aside,
//! with those of its bindings still open, and hands it back when the run's hold ends.
//!
//! Every change of holder raises the lease version by one, so a reader of the holder keeps
//! whichever reading is newest.
//!
//! Every decision reads and replaces the holder under one lock with no wait in between, so two
//! takes cannot both win. Changes of holder run one at a time: while one is being broadcast, the
//! next waits for it to settle and then decides on the holder it left, and every check and reading
//! waits the same way, so none sees a holder no broadcast has confirmed. A take whose broadcast
//! fails is undone, and a hand-back whose broadcast fails leaves nobody holding, so no holder
//! stands unannounced; a release to nobody whose broadcast fails still stands, because the holder
//! it ended is gone. Either failure reaches the caller, and every caller that joined it.

mod write_admission;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt as _;
use futures::future::{BoxFuture, Shared};
use serde_json::json;
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::TerminalId;
use sidekicks_contracts::terminal::control::{
    LeaseVersion, TerminalControlChangedPayload, TerminalControlChangedReason,
    TerminalControlHeldByOtherDetails, TerminalControlHolder, TerminalControlTakeResponse,
};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::TransportId;

use crate::control_lease::write_admission::WaitingWrite;
pub(crate) use crate::control_lease::write_admission::WriteAdmission;

/// One device connection: the device and the connection it called on.
#[derive(Clone, Debug)]
pub struct ShellConnection {
    /// The calling device.
    pub device_id: DeviceId,
    /// The connection it called on.
    pub transport_id: TransportId,
}

/// A device connection asking for a shell through its pane's output subscription to that shell.
#[derive(Clone, Debug)]
pub struct ShellLeaseCaller {
    /// The calling device and connection.
    pub connection: ShellConnection,
    /// The pane's output subscription to the shell.
    pub output_subscription_id: SubscriptionId,
}

/// An agent's running command asking for a shell through the run's write path.
#[derive(Clone, Debug)]
pub(crate) struct ShellLeaseRun {
    /// The run.
    pub(crate) run_id: RunId,
    /// The command it holds the shell for.
    pub(crate) command_id: CommandId,
}

/// Who writes one frame to a shell: a device's connection, or an agent's run on this machine.
#[derive(Clone, Debug)]
pub(crate) enum ShellWriter {
    /// A device's pane.
    Device(ShellLeaseCaller),
    /// An agent's run.
    Run(RunId),
}

/// Records one change of holder; a failure fails the act that made the change.
pub type LeaseBroadcast = Arc<
    dyn Fn(TerminalControlChangedPayload) -> BoxFuture<'static, Result<(), DomainError>>
        + Send
        + Sync,
>;

/// Refuses a device caller whose pane output subscription, or whose shell, has ended. Called under
/// the lease's lock with each binding a take or a write adds for that caller, so it must not block.
pub(crate) type EndedCallerCheck =
    Arc<dyn Fn(&ShellLeaseCaller) -> Result<(), DomainError> + Send + Sync>;

/// Who holds a shell and the lease version that reading was taken at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LeaseReading {
    /// The holder, or `None` while nobody holds the shell.
    pub(crate) holder: Option<TerminalControlHolder>,
    /// The lease version the holder was read at.
    pub(crate) lease_version: LeaseVersion,
}

/// A device's hold, bound to each pane output subscription it was taken through, by the
/// connection that subscription belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
struct DeviceHold {
    device_id: DeviceId,
    bindings: HashMap<SubscriptionId, TransportId>,
}

impl DeviceHold {
    fn of(caller: &ShellLeaseCaller) -> Self {
        Self {
            device_id: caller.connection.device_id.clone(),
            bindings: HashMap::from([(
                caller.output_subscription_id,
                caller.connection.transport_id,
            )]),
        }
    }

    /// Whether the connection is one the hold is bound to; a connection belongs to one device.
    fn is_bound_to(&self, connection: &ShellConnection) -> bool {
        self.device_id == connection.device_id
            && self
                .bindings
                .values()
                .any(|transport_id| *transport_id == connection.transport_id)
    }

    /// Binds the caller's pane to the hold; nothing changes when it already is.
    fn bind(&mut self, caller: &ShellLeaseCaller) {
        self.bindings
            .entry(caller.output_subscription_id)
            .or_insert(caller.connection.transport_id);
    }
}

/// A run's hold carries the device hold it took the shell from, handed back when the run's hold
/// ends, or `None` when it took the shell from nobody.
#[derive(Clone, Debug, PartialEq, Eq)]
struct RunHold {
    run_id: RunId,
    command_id: CommandId,
    kept_aside: Option<DeviceHold>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum LeaseHolder {
    Device(DeviceHold),
    Run(RunHold),
}

/// The broadcast of the one change of holder in flight: its failure shared by every act that
/// waits on it.
type PendingBroadcast = Shared<BoxFuture<'static, Result<(), Arc<DomainError>>>>;

/// The lease's state, read and replaced only under its lock.
struct LeaseState {
    holder: Option<LeaseHolder>,
    lease_version: u64,
    pending: Option<PendingBroadcast>,
    /// The writes that came while a change of holder was in flight, in the order they came;
    /// empty whenever none is.
    waiting_writes: VecDeque<WaitingWrite>,
}

impl LeaseState {
    /// A change of holder, raising the lease version. An undone change raises it again, so a
    /// reading taken after the undo is newer than the change no broadcast confirmed.
    fn replace_holder(&mut self, next: Option<LeaseHolder>) {
        self.holder = next;
        self.lease_version += 1;
    }
}

/// What a decision under the lock leads to.
enum Step<T> {
    /// The act is done.
    Done(Result<T, DomainError>),
    /// A change in flight must settle first; the act decides again after it.
    Settle(PendingBroadcast),
    /// The act's own change, or one it joined: its failure is the act's.
    Join(PendingBroadcast),
}

/// The lease's fixed facts and its state, shared with the task that broadcasts a change.
struct LeaseShared {
    session_id: SessionId,
    terminal_id: TerminalId,
    /// This machine's own device id, which a run's hold names as its device.
    machine_device_id: DeviceId,
    broadcast: LeaseBroadcast,
    refuse_ended_caller: EndedCallerCheck,
    state: Mutex<LeaseState>,
}

/// One shell's control lease, kept with the shell it guards. Takes and releases broadcast each
/// change of holder; the `admit_*` checks refuse with `terminal.control.heldByOther` or
/// `terminal.control.notHeld` when the caller may not act, and `admit_write` takes a shell nobody
/// holds for the device writing to it.
pub struct ShellControlLease {
    shared: Arc<LeaseShared>,
}

impl ShellControlLease {
    /// The lease of `terminal_id` in `session_id`, held by nobody at version 0; `broadcast`
    /// records each change of holder, and `refuse_ended_caller` refuses a caller whose pane or
    /// shell has ended.
    pub fn new(
        session_id: SessionId,
        terminal_id: TerminalId,
        machine_device_id: DeviceId,
        broadcast: LeaseBroadcast,
        refuse_ended_caller: EndedCallerCheck,
    ) -> Self {
        Self {
            shared: Arc::new(LeaseShared {
                session_id,
                terminal_id,
                machine_device_id,
                broadcast,
                refuse_ended_caller,
                state: Mutex::new(LeaseState {
                    holder: None,
                    lease_version: 0,
                    pending: None,
                    waiting_writes: VecDeque::new(),
                }),
            }),
        }
    }

    /// Takes the shell for a device connection, bound to the output subscription it names. A
    /// device's retake of a shell it holds sends no broadcast and adds that binding; while the
    /// take that gave the device the hold is still being broadcast, the retake waits for it and
    /// fails with it. `force` moves the shell off another device; nothing moves it off a run.
    /// Refuses a caller whose pane or shell ended before anything binds to it, and a shell another
    /// holds with `terminal.control.heldByOther`.
    pub async fn take(
        &self,
        caller: &ShellLeaseCaller,
        force: bool,
    ) -> Result<TerminalControlTakeResponse, DomainError> {
        let response = TerminalControlTakeResponse {
            terminal_id: self.shared.terminal_id.clone(),
            holder_device_id: caller.connection.device_id.clone(),
        };
        self.decide(|shared, state| {
            if let Err(refusal) = (shared.refuse_ended_caller)(caller) {
                return Step::Done(Err(refusal));
            }
            if let Some(LeaseHolder::Device(hold)) = &mut state.holder
                && hold.device_id == caller.connection.device_id
            {
                // A binding beside the holder, announced by nobody; undoing the hold drops it.
                hold.bind(caller);
                return match &state.pending {
                    Some(pending) => Step::Join(pending.clone()),
                    None => Step::Done(Ok(())),
                };
            }
            if let Some(pending) = &state.pending {
                return Step::Settle(pending.clone());
            }
            match &state.holder {
                Some(holder @ LeaseHolder::Run(_)) => Step::Done(Err(shared.held_by_other(holder))),
                Some(holder @ LeaseHolder::Device(_)) if !force => {
                    Step::Done(Err(shared.held_by_other(holder)))
                }
                Some(LeaseHolder::Device(_)) => Step::Join(shared.change_holder(
                    state,
                    Some(LeaseHolder::Device(DeviceHold::of(caller))),
                    TerminalControlChangedReason::TakenByForce,
                )),
                None => Step::Join(shared.change_holder(
                    state,
                    Some(LeaseHolder::Device(DeviceHold::of(caller))),
                    TerminalControlChangedReason::Taken,
                )),
            }
        })
        .await?;
        Ok(response)
    }

    /// Takes the shell for an agent's running command, off a device's hold too, which it keeps
    /// aside for the hand-back. Answers `false` with nothing changed when `is_shell_idle`, called
    /// under the lease's lock, says something was typed at the prompt; fails with the take's
    /// broadcast failure.
    pub(crate) async fn take_for_run(
        &self,
        run: &ShellLeaseRun,
        is_shell_idle: impl Fn() -> bool,
    ) -> Result<bool, DomainError> {
        self.decide(|shared, state| {
            if let Some(LeaseHolder::Run(hold)) = &state.holder
                && hold.run_id == run.run_id
                && hold.command_id == run.command_id
            {
                return match &state.pending {
                    Some(pending) => Step::Join(pending.clone()),
                    None => Step::Done(Ok(true)),
                };
            }
            if let Some(pending) = &state.pending {
                return Step::Settle(pending.clone());
            }
            if !is_shell_idle() {
                return Step::Done(Ok(false));
            }
            let kept_aside = match &state.holder {
                Some(LeaseHolder::Device(hold)) => Some(hold.clone()),
                Some(LeaseHolder::Run(hold)) => hold.kept_aside.clone(),
                None => None,
            };
            let run_hold = LeaseHolder::Run(RunHold {
                run_id: run.run_id,
                command_id: run.command_id.clone(),
                kept_aside,
            });
            Step::Join(shared.change_holder(
                state,
                Some(run_hold),
                TerminalControlChangedReason::Taken,
            ))
        })
        .await
        .map(|joined| joined.unwrap_or(true))
    }

    /// Hands a resize or a pane's appearance to `admitted`, under the lease's lock with the check,
    /// only from a connection holding the shell. Another device's or a run's hold refuses it
    /// `terminal.control.heldByOther`; nobody's, or another connection of the caller's own device,
    /// `terminal.control.notHeld`.
    pub(crate) async fn admit_from_holding_connection<T>(
        &self,
        caller: &ShellConnection,
        admitted: impl FnOnce() -> T,
    ) -> Result<T, DomainError> {
        let state = self.settled().await;
        match &state.holder {
            Some(holder @ LeaseHolder::Run(_)) => Err(self.shared.held_by_other(holder)),
            Some(holder @ LeaseHolder::Device(hold)) if hold.device_id != caller.device_id => {
                Err(self.shared.held_by_other(holder))
            }
            Some(LeaseHolder::Device(hold)) if hold.is_bound_to(caller) => Ok(admitted()),
            Some(LeaseHolder::Device(_)) | None => Err(self.shared.not_held()),
        }
    }

    /// Hands a close to `close`, under the lease's lock with the check, unless a run holds the
    /// shell, or another device does without `force`, which `terminal.control.heldByOther`
    /// refuses.
    pub(crate) async fn admit_close<T>(
        &self,
        device_id: &DeviceId,
        force: bool,
        close: impl FnOnce() -> T,
    ) -> Result<T, DomainError> {
        let state = self.settled().await;
        match &state.holder {
            Some(holder @ LeaseHolder::Run(_)) => Err(self.shared.held_by_other(holder)),
            Some(holder @ LeaseHolder::Device(hold)) if hold.device_id != *device_id && !force => {
                Err(self.shared.held_by_other(holder))
            }
            Some(LeaseHolder::Device(_)) | None => Ok(close()),
        }
    }

    /// Drops an ended connection's bindings, giving the shell back once none remains. A hold kept
    /// aside under a run loses them too, and is dropped once none remains. Fails with the release
    /// broadcast's failure, the release standing.
    pub(crate) async fn release_connection(
        &self,
        transport_id: TransportId,
    ) -> Result<(), DomainError> {
        self.drop_bindings(
            |_subscription, bound| bound == transport_id,
            TerminalControlChangedReason::AutoReleasedDisconnect,
        )
        .await
    }

    /// Drops the bindings closed pane output subscriptions carried, giving the shell back once
    /// none remains, in one change of holder. A hold kept aside under a run loses them too. Fails
    /// with the release broadcast's failure, the release standing.
    pub(crate) async fn release_subscriptions(
        &self,
        output_subscription_ids: &[SubscriptionId],
    ) -> Result<(), DomainError> {
        self.drop_bindings(
            |subscription, _bound| output_subscription_ids.contains(&subscription),
            TerminalControlChangedReason::AutoReleasedPaneClosed,
        )
        .await
    }

    /// Ends a run's hold when the command it holds the shell for ends; a run past that command
    /// keeps it. The shell goes back to the device hold kept aside, or to nobody. Fails with the
    /// hand-back broadcast's failure, nobody holding.
    pub(crate) async fn release_command(&self, run: &ShellLeaseRun) -> Result<(), DomainError> {
        self.release_run_hold(
            |hold| hold.run_id == run.run_id && hold.command_id == run.command_id,
            TerminalControlChangedReason::AutoReleasedCommandEnded,
        )
        .await
    }

    /// Ends a run's hold when the run leaves its running state. The shell goes back to the device
    /// hold kept aside, or to nobody. Fails with the hand-back broadcast's failure, nobody
    /// holding.
    pub(crate) async fn release_run(&self, run_id: RunId) -> Result<(), DomainError> {
        self.release_run_hold(
            |hold| hold.run_id == run_id,
            TerminalControlChangedReason::AutoReleasedRunIdle,
        )
        .await
    }

    /// Who holds the shell once every change in flight has settled, and the lease version it was
    /// read at, for a shell list entry or an opening frame.
    pub(crate) async fn read_holder(&self) -> LeaseReading {
        let state = self.settled().await;
        LeaseReading {
            holder: state
                .holder
                .as_ref()
                .map(|holder| self.shared.describe(holder)),
            lease_version: SafeInt::new(state.lease_version)
                .expect("a lease version stays far below 2^53"),
        }
    }

    /// Ends a run's hold that `is_ended` picks, handing the shell back to the device hold kept
    /// aside, or to nobody.
    async fn release_run_hold(
        &self,
        is_ended: impl Fn(&RunHold) -> bool,
        reason: TerminalControlChangedReason,
    ) -> Result<(), DomainError> {
        self.decide(|shared, state| {
            if let Some(pending) = &state.pending {
                return Step::Settle(pending.clone());
            }
            match &state.holder {
                Some(LeaseHolder::Run(hold)) if is_ended(hold) => {
                    let kept_aside = hold.kept_aside.clone().map(LeaseHolder::Device);
                    Step::Join(shared.change_holder(state, kept_aside, reason))
                }
                Some(LeaseHolder::Run(_) | LeaseHolder::Device(_)) | None => Step::Done(Ok(())),
            }
        })
        .await
        .map(drop)
    }

    /// Drops the bindings `is_ended` picks from the device hold, or the one kept aside under a
    /// run, giving the shell back to nobody once the holding device has none left.
    async fn drop_bindings(
        &self,
        is_ended: impl Fn(SubscriptionId, TransportId) -> bool,
        reason: TerminalControlChangedReason,
    ) -> Result<(), DomainError> {
        self.decide(|shared, state| {
            if let Some(pending) = &state.pending {
                return Step::Settle(pending.clone());
            }
            let hold = match &mut state.holder {
                Some(
                    LeaseHolder::Device(hold)
                    | LeaseHolder::Run(RunHold {
                        kept_aside: Some(hold),
                        ..
                    }),
                ) => hold,
                Some(LeaseHolder::Run(RunHold {
                    kept_aside: None, ..
                }))
                | None => return Step::Done(Ok(())),
            };
            let bound_before = hold.bindings.len();
            hold.bindings
                .retain(|subscription, bound| !is_ended(*subscription, *bound));
            if hold.bindings.len() == bound_before || !hold.bindings.is_empty() {
                return Step::Done(Ok(()));
            }
            match &mut state.holder {
                Some(LeaseHolder::Run(run_hold)) => {
                    run_hold.kept_aside = None;
                    Step::Done(Ok(()))
                }
                Some(LeaseHolder::Device(_)) | None => {
                    Step::Join(shared.change_holder(state, None, reason))
                }
            }
        })
        .await
        .map(drop)
    }

    /// Runs `decide` under the lease's lock until it is done: after waiting out a change in
    /// flight it decides again, and an act that started or joined a change answers its outcome,
    /// `None` for a change it joined.
    async fn decide<T>(
        &self,
        mut decide: impl FnMut(&Arc<LeaseShared>, &mut LeaseState) -> Step<T>,
    ) -> Result<Option<T>, DomainError> {
        loop {
            let step = {
                let mut state = self.shared.lock();
                decide(&self.shared, &mut state)
            };
            match step {
                Step::Done(result) => return result.map(Some),
                Step::Settle(pending) => drop(pending.await),
                Step::Join(pending) => {
                    return pending
                        .await
                        .map(|()| None)
                        .map_err(|failure| rejoin(&failure));
                }
            }
        }
    }

    /// The state's lock once no change of holder is in flight; that change's failure is its own
    /// caller's to report.
    async fn settled(&self) -> MutexGuard<'_, LeaseState> {
        loop {
            let pending = {
                let state = self.shared.lock();
                match &state.pending {
                    None => return state,
                    Some(pending) => pending.clone(),
                }
            };
            drop(pending.await);
        }
    }
}

impl LeaseShared {
    fn lock(&self) -> MutexGuard<'_, LeaseState> {
        self.state
            .lock()
            .expect("no panic holds a lease's lock, since a panic ends the daemon")
    }

    /// The holder as the wire names it.
    fn describe(&self, holder: &LeaseHolder) -> TerminalControlHolder {
        match holder {
            LeaseHolder::Device(hold) => TerminalControlHolder {
                holder_device_id: hold.device_id.clone(),
                holder_run_id: None,
                holder_command_id: None,
            },
            LeaseHolder::Run(hold) => TerminalControlHolder {
                holder_device_id: self.machine_device_id.clone(),
                holder_run_id: Some(hold.run_id),
                holder_command_id: Some(hold.command_id.clone()),
            },
        }
    }

    /// The refusal of a take, resize or close because `holder`, another device or a run, holds
    /// the shell.
    fn held_by_other(&self, holder: &LeaseHolder) -> DomainError {
        let described = self.describe(holder);
        let message = if described.holder_run_id.is_some() {
            format!(
                "shell {} is held by an agent's running command",
                self.terminal_id.as_str()
            )
        } else {
            format!(
                "shell {} is held by another device",
                self.terminal_id.as_str()
            )
        };
        DomainError::new(message, RefusalCode::TerminalControlHeldByOther).with_detail(
            TerminalControlHeldByOtherDetails {
                terminal_id: self.terminal_id.clone(),
                holder_device_id: described.holder_device_id,
                holder_run_id: described.holder_run_id,
                holder_command_id: described.holder_command_id,
            },
        )
    }

    /// The refusal of a write from a writer that does not hold the shell, or a resize from a
    /// connection that does not while nobody else holds it or its own device holds it on another
    /// connection.
    fn not_held(&self) -> DomainError {
        DomainError::new(
            format!(
                "shell {} is not held by this writer",
                self.terminal_id.as_str()
            ),
            RefusalCode::TerminalControlNotHeld,
        )
        .with_detail(json!({ "terminalId": self.terminal_id }))
    }

    /// The broadcast of a change from `previous` to `next` for `reason` at `lease_version`.
    fn payload(
        &self,
        previous: Option<&LeaseHolder>,
        next: Option<&LeaseHolder>,
        reason: TerminalControlChangedReason,
        lease_version: u64,
    ) -> TerminalControlChangedPayload {
        let session_id = self.session_id;
        let terminal_id = self.terminal_id.clone();
        let lease_version =
            SafeInt::new(lease_version).expect("a change raises the version above 0, below 2^53");
        let previous_device = previous.map(|holder| self.describe(holder).holder_device_id);
        let next_holder = next.map(|holder| self.describe(holder));
        let next_device = next_holder
            .as_ref()
            .map(|holder| holder.holder_device_id.clone());
        let previous_device_of_release = || {
            previous_device
                .clone()
                .expect("a release ends a hold, so a holder came before it")
        };
        match reason {
            TerminalControlChangedReason::Taken => {
                let holder = next_holder.expect("a take names its holder");
                TerminalControlChangedPayload::Taken {
                    session_id,
                    terminal_id,
                    lease_version,
                    holder_device_id: holder.holder_device_id,
                    holder_run_id: holder.holder_run_id,
                    holder_command_id: holder.holder_command_id,
                    previous_holder_device_id: previous_device,
                }
            }
            TerminalControlChangedReason::TakenByForce => {
                TerminalControlChangedPayload::TakenByForce {
                    session_id,
                    terminal_id,
                    lease_version,
                    holder_device_id: next_device.expect("a forced take names its holder"),
                    holder_run_id: None,
                    holder_command_id: None,
                    previous_holder_device_id: previous_device_of_release(),
                }
            }
            TerminalControlChangedReason::AutoReleasedDisconnect => {
                TerminalControlChangedPayload::AutoReleasedDisconnect {
                    session_id,
                    terminal_id,
                    lease_version,
                    holder_device_id: None,
                    holder_run_id: None,
                    holder_command_id: None,
                    previous_holder_device_id: previous_device_of_release(),
                }
            }
            TerminalControlChangedReason::AutoReleasedPaneClosed => {
                TerminalControlChangedPayload::AutoReleasedPaneClosed {
                    session_id,
                    terminal_id,
                    lease_version,
                    holder_device_id: None,
                    holder_run_id: None,
                    holder_command_id: None,
                    previous_holder_device_id: previous_device_of_release(),
                }
            }
            TerminalControlChangedReason::AutoReleasedCommandEnded => {
                TerminalControlChangedPayload::AutoReleasedCommandEnded {
                    session_id,
                    terminal_id,
                    lease_version,
                    holder_device_id: next_device,
                    holder_run_id: None,
                    holder_command_id: None,
                    previous_holder_device_id: previous_device_of_release(),
                }
            }
            TerminalControlChangedReason::AutoReleasedRunIdle => {
                TerminalControlChangedPayload::AutoReleasedRunIdle {
                    session_id,
                    terminal_id,
                    lease_version,
                    holder_device_id: next_device,
                    holder_run_id: None,
                    holder_command_id: None,
                    previous_holder_device_id: previous_device_of_release(),
                }
            }
        }
    }

    /// Replaces the holder at once, then broadcasts the change on a task of its own, so a caller
    /// that stops waiting leaves no change half made; once it settles, the writes that waited for
    /// it are admitted in the order they came. Called only while no other change is in
    /// flight, so a failed take puts back exactly the holder it replaced, and a failed hand-back
    /// leaves nobody holding rather than an unannounced device; a failed release to nobody stands,
    /// as the hold it ended is gone.
    fn change_holder(
        self: &Arc<Self>,
        state: &mut LeaseState,
        next: Option<LeaseHolder>,
        reason: TerminalControlChangedReason,
    ) -> PendingBroadcast {
        let previous = state.holder.clone();
        let payload = self.payload(
            previous.as_ref(),
            next.as_ref(),
            reason,
            state.lease_version + 1,
        );
        state.replace_holder(next);
        let broadcasting = (self.broadcast)(payload);
        let shared = Arc::clone(self);
        let change = tokio::spawn(async move {
            let broadcast = broadcasting.await;
            let mut state = shared.lock();
            if broadcast.is_err() {
                let restored = match reason {
                    TerminalControlChangedReason::Taken
                    | TerminalControlChangedReason::TakenByForce => previous,
                    TerminalControlChangedReason::AutoReleasedDisconnect
                    | TerminalControlChangedReason::AutoReleasedPaneClosed
                    | TerminalControlChangedReason::AutoReleasedCommandEnded
                    | TerminalControlChangedReason::AutoReleasedRunIdle => None,
                };
                // A release to nobody leaves the holder as it was, so the version stays.
                if restored != state.holder {
                    state.replace_holder(restored);
                }
            }
            state.pending = None;
            let broadcast = broadcast.map_err(Arc::new);
            shared.admit_waiting_writes(&mut state, broadcast.as_ref().err());
            broadcast
        });
        let pending = async move {
            change.await.unwrap_or_else(|stopped| {
                Err(Arc::new(
                    DomainError::new(
                        "the shell's change of holder stopped before it was broadcast",
                        RefusalCode::SystemInternalError,
                    )
                    .with_source(stopped),
                ))
            })
        }
        .boxed()
        .shared();
        state.pending = Some(pending.clone());
        pending
    }
}

/// The failure of a change of holder, as each caller that waited on it receives it: the same
/// code, words and detail, with the shared failure as its source.
fn rejoin(failure: &Arc<DomainError>) -> DomainError {
    DomainError {
        message: failure.message.clone(),
        code: failure.code,
        detail: failure.detail.clone(),
        source: Some(Box::new(Arc::clone(failure))),
    }
}

#[cfg(test)]
mod tests;
