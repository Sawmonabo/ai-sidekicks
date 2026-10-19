//! The run engine's inbound dispatch: where each provider delivery is attributed to its execution
//! before anything is written. A lifecycle event, child run, marker, live state, unstamped row or
//! permission ask from the execution before an undo's cut is absorbed there; one for a run already
//! ended is absorbed by the refusal of its own write, with a diagnostic unless it is the provider's
//! end of a turn the daemon interrupted; any other row is appended, stamped with its source pair
//! when it is late, a reasoning update among them with its body, never dropped. A session notice
//! or session row belongs to no execution and is appended as it is.

pub(crate) mod rows;
#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::{Map, Value};
use sidekicks_contracts::event::declared_variants::{AgentOutputPayload, RunAgentOutputPayload};
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::events::RunStateChangeState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::events::{
    RunSafetyBufferingUpdatedPayload, SessionNoticePostedPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::events::log_service::EventLogService;
use crate::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use crate::events::session::version::SESSION_EVENT_VERSION;
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::provider::port::run_state_publisher::RunStatePublisher;
use crate::session::run::engine::turns::ProviderTurnEnd;
use crate::session::run::engine::{RunEngine, RunEngineError, RunMarker};
use crate::session::run::epochs::{
    DeliveryAttribution, DeliveryOperation, EpochBinding, EpochCursorError, ExecutionEpochs,
};
use crate::session::run::inbound::rows::{
    LateAppendableRow, SessionScopedRow, UnstampedRow, stamp,
};
use crate::session::run::read::RunRead;
use crate::session::run::refusals::RunRefusal;
use crate::session::run::state_change::RunStateChange;

/// The runtime binding a delivery arrived on, and the provider operation it belongs to, where it
/// has one.
#[derive(Debug)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the provider's event delivery names each delivery's binding"
    )
)]
pub(crate) struct DeliveryBinding<'key> {
    /// The binding.
    pub(crate) binding_id: RuntimeBindingId,
    /// The provider operation.
    pub(crate) operation: Option<DeliveryOperation<'key>>,
}

/// One delivery a provider driver hands the run engine, on its binding and in that binding's
/// delivery order, or about the session as a whole on no binding.
#[derive(Debug)]
#[expect(
    dead_code,
    reason = "the provider's event delivery builds each delivery it hands over"
)]
pub(crate) enum InboundDelivery<'key> {
    /// The binding opened its next turn.
    TurnBoundary {
        /// The binding.
        binding_id: RuntimeBindingId,
    },
    /// The provider moved a run.
    RunLifecycle {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The move.
        change: RunStateChange,
        /// The end of the turn the move ends, where the provider's end frame reported one.
        turn_end: Option<ProviderTurnEnd>,
        /// Whether this is the provider's end of a turn the daemon's own interrupt stopped, which
        /// the daemon may have written first; refused then, it is absorbed with no diagnostic.
        is_daemon_interrupt_end: bool,
    },
    /// The provider started a turn itself with messages it kept from the interrupted `run_id`'s
    /// turn, which continues that run.
    RunContinued {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The interrupted run.
        run_id: RunId,
    },
    /// The provider started a subagent beneath `parent_run_id`.
    ChildRun {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The run the subagent starts under.
        parent_run_id: RunId,
    },
    /// A marker the provider reported on a live run.
    RunMarker {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The marker.
        marker: RunMarker,
    },
    /// A state the run's stream shows live and nothing stores.
    LiveRunState {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The state.
        state: RunSafetyBufferingUpdatedPayload,
    },
    /// An assistant's reasoning on a run, appended whole with its body.
    ThinkingUpdate {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The update's payload, without the stamp.
        payload: RunAgentOutputPayload,
        /// The reasoning text, stored beside the payload.
        content: String,
    },
    /// A notice about the session `session_id`, on no binding.
    SessionNotice {
        /// The session the notice names.
        session_id: SessionId,
        /// The notice.
        notice: SessionNoticePostedPayload,
    },
    /// A row about the session as a whole, on no binding.
    SessionEvent {
        /// The row.
        row: SessionScopedRow,
    },
    /// The provider asked the person's permission.
    PermissionAsk {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
    },
    /// A row that takes the stamp when it is late.
    SessionRow {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The row.
        row: LateAppendableRow,
        /// The prose of a body-bearing row, stored beside its payload.
        content: Option<String>,
    },
    /// A row on a run that takes no stamp.
    UnstampedRow {
        /// Where it arrived.
        binding: DeliveryBinding<'key>,
        /// The row.
        row: UnstampedRow,
    },
}

/// Why a delivery was absorbed: it came from before an undo's cut, or its run had already ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LateEventAbsorbReason {
    /// From the execution before an undo's cut.
    BeforeCut,
    /// For a run that had already ended.
    RunEnded,
}

impl LateEventAbsorbReason {
    // The reason as the diagnostic's details name it.
    fn as_str(self) -> &'static str {
        match self {
            Self::BeforeCut => "beforeCut",
            Self::RunEnded => "runEnded",
        }
    }

    // Why the delivery was disposed of, in the diagnostic's words.
    fn sentence(self) -> &'static str {
        match self {
            Self::BeforeCut => {
                "the delivery belongs to the execution before an undo's cut, so it is absorbed at \
                 the epoch check and nothing is written"
            }
            Self::RunEnded => {
                "the delivery's run had already ended, so its write was refused and nothing is \
                 written"
            }
        }
    }
}

/// What the dispatch did with a delivery. `AskAdmitted` is a permission ask of the current
/// execution, which the caller hands to the approval pipeline; `ChildRunStarted` carries the
/// child's new run, which the caller keeps for the subagent's later deliveries; an appended row
/// carries the id of the event written for it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum InboundOutcome {
    /// The binding's next turn opened.
    TurnOpened,
    /// The run moved, as the move left it.
    Transitioned {
        /// The run.
        run: RunRead,
    },
    /// The subagent's run started.
    ChildRunStarted {
        /// Its run.
        run_id: RunId,
    },
    /// The live state went to the run's state stream.
    Published,
    /// The permission ask belongs to the current execution.
    AskAdmitted,
    /// The row was appended as it came.
    Appended {
        /// The event written.
        event_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
    },
    /// The row was appended stamped as possibly late.
    AppendedStamped {
        /// The event written.
        event_id: FreeFormText<EVENT_FIELD_MAX_LEN>,
        /// The pair it was stamped with.
        source: EpochPosition,
    },
    /// Nothing was written.
    Absorbed {
        /// Why.
        reason: LateEventAbsorbReason,
    },
}

impl InboundOutcome {
    /// The id of the event a delivery was written as; `None` where nothing was written.
    #[expect(
        dead_code,
        reason = "the provider's event delivery reads the event a delivery was written as"
    )]
    pub(crate) fn event_id(&self) -> Option<&FreeFormText<EVENT_FIELD_MAX_LEN>> {
        match self {
            Self::Appended { event_id } | Self::AppendedStamped { event_id, .. } => Some(event_id),
            Self::TurnOpened
            | Self::Transitioned { .. }
            | Self::ChildRunStarted { .. }
            | Self::Published
            | Self::AskAdmitted
            | Self::Absorbed { .. } => None,
        }
    }
}

/// Why a delivery was neither written, routed nor absorbed; nothing of it is kept.
#[derive(Debug, thiserror::Error)]
pub(crate) enum InboundDispatchError {
    /// The delivery's binding has no epoch cursor open.
    #[error(transparent)]
    Cursor(#[from] EpochCursorError),
    /// The engine refused or failed the delivery's move, for a reason other than its run's end.
    #[error(transparent)]
    Engine(#[from] RunEngineError),
    /// The row's event breaks a check of its type.
    #[error("the delivery's event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep the row.
    #[error("the delivery's event was not appended")]
    Append(#[from] SessionEventAppendError),
}

/// Takes each provider delivery in, attributes it, and writes, routes or absorbs it.
pub(crate) struct RunInboundDispatch {
    engine: Arc<RunEngine>,
    epochs: Arc<Mutex<ExecutionEpochs>>,
    run_state_publisher: Arc<dyn RunStatePublisher>,
    appender: SessionEventAppender,
}

// A delivery attributed to its execution, with what is left to do for it.
enum Attributed {
    Settled(InboundOutcome),
    Append(PendingAppend),
    Run {
        binding: EpochBinding,
        attribution: DeliveryAttribution,
        work: RunWork,
    },
}

// A row to append, with the pair it was stamped with, where it was.
struct PendingAppend {
    session_id: SessionId,
    event: SessionEvent,
    linkage: SessionEventLinkage,
    source: Option<EpochPosition>,
}

// A delivery on a binding that is absorbed when it comes from before a cut.
enum Absorbable {
    PermissionAsk,
    LiveRunState(RunSafetyBufferingUpdatedPayload),
    UnstampedRow(UnstampedRow),
    Run(RunWork),
}

// The engine call a delivery on a binding makes once it is attributed.
enum RunWork {
    Lifecycle {
        change: RunStateChange,
        turn_end: Option<ProviderTurnEnd>,
        is_daemon_interrupt_end: bool,
    },
    Continued {
        run_id: RunId,
    },
    ChildRun {
        parent_run_id: RunId,
    },
    Marker {
        marker: RunMarker,
    },
}

// What an absorbed delivery's diagnostic names of it: its kind, the run it names where it names
// one, and the state a lifecycle move asked for.
struct AbsorbedDelivery {
    kind: &'static str,
    run_id: Option<RunId>,
    new_state: Option<RunStateChangeState>,
}

impl Absorbable {
    fn absorbed(&self) -> AbsorbedDelivery {
        let (kind, run_id, new_state) = match self {
            Self::PermissionAsk => ("permissionAsk", None, None),
            Self::LiveRunState(state) => ("liveRunState", Some(state.run_id), None),
            Self::UnstampedRow(row) => ("unstampedRow", Some(row.run_id()), None),
            Self::Run(work) => return work.absorbed(),
        };
        AbsorbedDelivery {
            kind,
            run_id,
            new_state,
        }
    }
}

impl RunWork {
    fn absorbed(&self) -> AbsorbedDelivery {
        let (kind, run_id, new_state) = match self {
            Self::Lifecycle { change, .. } => {
                ("runLifecycle", change.run_id, Some(change.entry.state()))
            }
            Self::Continued { run_id } => ("runContinued", *run_id, None),
            Self::ChildRun { parent_run_id } => ("childRun", *parent_run_id, None),
            Self::Marker { marker } => ("runMarker", marker.run_id(), None),
        };
        AbsorbedDelivery {
            kind,
            run_id: Some(run_id),
            new_state,
        }
    }
}

impl RunInboundDispatch {
    /// A dispatch moving runs through `engine`, attributing on `epochs`, the cursors the binding
    /// cursors keep, sending live states to `run_state_publisher` and appending rows to
    /// `event_log`.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's start builds the one dispatch")
    )]
    pub(crate) fn new(
        engine: Arc<RunEngine>,
        epochs: Arc<Mutex<ExecutionEpochs>>,
        run_state_publisher: Arc<dyn RunStatePublisher>,
        event_log: Arc<EventLogService>,
    ) -> Self {
        Self {
            engine,
            epochs,
            run_state_publisher,
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
        }
    }

    /// Dispatches one delivery. It is attributed, and a live state published, when the call is
    /// made, before the returned future is first polled, so calls for a binding are made in its
    /// delivery order. Fails with [`InboundDispatchError::Cursor`] for a binding with no cursor
    /// open, and with the engine's or the log's failure; a refusal for a run that has ended is no
    /// failure but an absorb, and a resend the engine owed after a move is logged, never failed.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the provider's event delivery hands each delivery to it"
        )
    )]
    pub(crate) fn dispatch<'dispatch>(
        &'dispatch self,
        delivery: InboundDelivery<'_>,
    ) -> impl Future<Output = Result<InboundOutcome, InboundDispatchError>> + Send + use<'dispatch>
    {
        let attributed = self.attribute(delivery);
        async move {
            match attributed? {
                Attributed::Settled(outcome) => Ok(outcome),
                Attributed::Append(append) => {
                    let draft = SessionEventDraft::of_session(append.session_id, &append.event)?;
                    let event_id = self.appender.append(draft, append.linkage).await?.id;
                    Ok(match append.source {
                        None => InboundOutcome::Appended { event_id },
                        Some(source) => InboundOutcome::AppendedStamped { event_id, source },
                    })
                }
                Attributed::Run {
                    binding,
                    attribution,
                    work,
                } => self.run(&binding, attribution, work).await,
            }
        }
    }

    // Attributes `delivery` and settles what needs no write: a turn boundary, a delivery from
    // before a cut, a permission ask and a live state.
    fn attribute(&self, delivery: InboundDelivery<'_>) -> Result<Attributed, EpochCursorError> {
        let (binding, absorbable) = match delivery {
            InboundDelivery::SessionNotice { session_id, notice } => {
                let event = SessionEvent::SessionNoticePosted(notice);
                return Ok(appended(
                    session_id,
                    event,
                    SessionEventLinkage::default(),
                    None,
                ));
            }
            InboundDelivery::SessionEvent { row } => {
                let (session_id, event, transactional_prelude) = row.into_event();
                let linkage = SessionEventLinkage {
                    transactional_prelude,
                    ..SessionEventLinkage::default()
                };
                return Ok(appended(session_id, event, linkage, None));
            }
            InboundDelivery::TurnBoundary { binding_id } => {
                return self.open_turn(&binding_id).map(Attributed::Settled);
            }
            InboundDelivery::SessionRow {
                binding,
                row,
                content,
            } => {
                let (session_id, event, source) = row.into_event(self.possible_source(&binding)?);
                return Ok(appended(session_id, event, body_linkage(content), source));
            }
            InboundDelivery::ThinkingUpdate {
                binding,
                mut payload,
                content,
            } => {
                let possible_source = self.possible_source(&binding)?;
                let source = stamp(
                    &mut payload.source_epoch,
                    &mut payload.source_position,
                    possible_source,
                );
                let session_id = payload.session_id;
                let event = SessionEvent::AgentThinkingUpdated(AgentOutputPayload::Run(payload));
                return Ok(appended(
                    session_id,
                    event,
                    body_linkage(Some(content)),
                    source,
                ));
            }
            InboundDelivery::PermissionAsk { binding } => (binding, Absorbable::PermissionAsk),
            InboundDelivery::LiveRunState { binding, state } => {
                (binding, Absorbable::LiveRunState(state))
            }
            InboundDelivery::UnstampedRow { binding, row } => {
                (binding, Absorbable::UnstampedRow(row))
            }
            InboundDelivery::RunLifecycle {
                binding,
                change,
                turn_end,
                is_daemon_interrupt_end,
            } => (
                binding,
                Absorbable::Run(RunWork::Lifecycle {
                    change,
                    turn_end,
                    is_daemon_interrupt_end,
                }),
            ),
            InboundDelivery::RunContinued { binding, run_id } => {
                (binding, Absorbable::Run(RunWork::Continued { run_id }))
            }
            InboundDelivery::ChildRun {
                binding,
                parent_run_id,
            } => (
                binding,
                Absorbable::Run(RunWork::ChildRun { parent_run_id }),
            ),
            InboundDelivery::RunMarker { binding, marker } => {
                (binding, Absorbable::Run(RunWork::Marker { marker }))
            }
        };
        let (attribution, epoch_binding) = {
            let mut epochs = self.lock_epochs();
            let attribution = epochs.attribute(&binding.binding_id, binding.operation)?;
            (attribution, epochs.binding(&binding.binding_id)?.clone())
        };
        // An unknown execution reads as current here: absorbing a live terminal or ask would leave
        // the provider waiting on it for good.
        if let DeliveryAttribution::BeforeCut { .. } = attribution {
            return Ok(Attributed::Settled(absorb(
                &epoch_binding,
                &absorbable.absorbed(),
                LateEventAbsorbReason::BeforeCut,
                attribution,
            )));
        }
        Ok(match absorbable {
            Absorbable::PermissionAsk => Attributed::Settled(InboundOutcome::AskAdmitted),
            Absorbable::LiveRunState(state) => {
                self.run_state_publisher.publish(state);
                Attributed::Settled(InboundOutcome::Published)
            }
            Absorbable::UnstampedRow(row) => {
                let (session_id, event) = row.into_event();
                appended(session_id, event, SessionEventLinkage::default(), None)
            }
            Absorbable::Run(work) => Attributed::Run {
                binding: epoch_binding,
                attribution,
                work,
            },
        })
    }

    // The pair a row on `binding` is stamped with once attributed: none for the current
    // execution; a row that may be from before the cut is stamped too, since a stamp only
    // supersedes it.
    fn possible_source(
        &self,
        binding: &DeliveryBinding<'_>,
    ) -> Result<Option<EpochPosition>, EpochCursorError> {
        let attribution = self
            .lock_epochs()
            .attribute(&binding.binding_id, binding.operation)?;
        Ok(match attribution {
            DeliveryAttribution::Current => None,
            DeliveryAttribution::BeforeCut { source } | DeliveryAttribution::Unknown { source } => {
                Some(source)
            }
        })
    }

    // Counts a turn boundary; one from before a cut is absorbed.
    fn open_turn(&self, binding_id: &RuntimeBindingId) -> Result<InboundOutcome, EpochCursorError> {
        let mut epochs = self.lock_epochs();
        let attribution = epochs.open_turn(binding_id)?;
        Ok(match attribution {
            DeliveryAttribution::Current => InboundOutcome::TurnOpened,
            DeliveryAttribution::BeforeCut { .. } | DeliveryAttribution::Unknown { .. } => absorb(
                epochs.binding(binding_id)?,
                &AbsorbedDelivery {
                    kind: "turnBoundary",
                    run_id: None,
                    new_state: None,
                },
                LateEventAbsorbReason::BeforeCut,
                attribution,
            ),
        })
    }

    // Makes a delivery's engine call; a run that has ended absorbs it.
    async fn run(
        &self,
        binding: &EpochBinding,
        attribution: DeliveryAttribution,
        work: RunWork,
    ) -> Result<InboundOutcome, InboundDispatchError> {
        let absorbed = work.absorbed();
        let run_ended = || {
            absorb(
                binding,
                &absorbed,
                LateEventAbsorbReason::RunEnded,
                attribution,
            )
        };
        Ok(match work {
            RunWork::Lifecycle {
                change,
                turn_end,
                is_daemon_interrupt_end,
            } => {
                let run_id = change.run_id;
                match self
                    .engine
                    .apply_provider_state_change(change, turn_end)
                    .await
                {
                    Ok(written) => InboundOutcome::Transitioned {
                        run: written.log_resend_failure(run_id),
                    },
                    // The end of a turn the daemon interrupted is expected to find the run ended.
                    Err(error) if is_ended_run_refusal(&error) && is_daemon_interrupt_end => {
                        InboundOutcome::Absorbed {
                            reason: LateEventAbsorbReason::RunEnded,
                        }
                    }
                    Err(error) if is_ended_run_refusal(&error) => run_ended(),
                    Err(error) => return Err(error.into()),
                }
            }
            RunWork::Continued { run_id } => {
                match self.engine.continue_run_with_kept_messages(run_id).await? {
                    Some(run) => InboundOutcome::Transitioned { run },
                    None => run_ended(),
                }
            }
            RunWork::ChildRun { parent_run_id } => {
                match self
                    .engine
                    .start_provider_subagent_run(parent_run_id)
                    .await?
                {
                    Some(run_id) => InboundOutcome::ChildRunStarted { run_id },
                    None => run_ended(),
                }
            }
            RunWork::Marker { marker } => match self.engine.append_run_marker(marker).await? {
                Some(event_id) => InboundOutcome::Appended { event_id },
                None => run_ended(),
            },
        })
    }

    fn lock_epochs(&self) -> MutexGuard<'_, ExecutionEpochs> {
        self.epochs.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

// Reports a delivery absorbed for `reason`, on `binding`, and answers that nothing was written.
fn absorb(
    binding: &EpochBinding,
    absorbed: &AbsorbedDelivery,
    reason: LateEventAbsorbReason,
    attribution: DeliveryAttribution,
) -> InboundOutcome {
    let before_cut = match attribution {
        DeliveryAttribution::BeforeCut { source } => Some(source),
        DeliveryAttribution::Current | DeliveryAttribution::Unknown { .. } => None,
    };
    let run_id = absorbed.run_id.unwrap_or(binding.run_id);
    let mut details = Map::new();
    details.insert("reason".to_owned(), Value::from(reason.as_str()));
    details.insert("deliveryKind".to_owned(), Value::from(absorbed.kind));
    details.insert("bindingId".to_owned(), Value::from(binding.id.as_str()));
    details.insert("runId".to_owned(), Value::from(run_id.text().as_str()));
    details.insert(
        "newState".to_owned(),
        absorbed.new_state.map_or(Value::Null, |state| {
            Value::from(<&'static str>::from(RunState::from(state)))
        }),
    );
    details.insert(
        "sourceEpoch".to_owned(),
        before_cut.map_or(Value::Null, |source| Value::from(source.epoch.0.get())),
    );
    details.insert(
        "sourcePosition".to_owned(),
        before_cut.map_or(Value::Null, |source| Value::from(source.position.0.get())),
    );
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: binding.provider_name.clone(),
        provider_account_id: binding.provider_account_id.clone(),
        kind: DriverDiagnosticKind::LateEventAbsorbed,
        raw_wire_type: None,
        disposition_reason: reason.sentence().to_owned(),
        details,
    });
    InboundOutcome::Absorbed { reason }
}

// A row to append as it was attributed.
fn appended(
    session_id: SessionId,
    event: SessionEvent,
    linkage: SessionEventLinkage,
    source: Option<EpochPosition>,
) -> Attributed {
    Attributed::Append(PendingAppend {
        session_id,
        event,
        linkage,
        source,
    })
}

// The linkage of a row whose prose, where it has one, is stored beside its payload.
fn body_linkage(content_body: Option<String>) -> SessionEventLinkage {
    SessionEventLinkage {
        content_body,
        ..SessionEventLinkage::default()
    }
}

// A provider's move refused because its run had ended, by the read or inside the write. A refusal
// the engine returns beside a failed write of the turn's end is a failure, not an absorb.
fn is_ended_run_refusal(error: &RunEngineError) -> bool {
    matches!(
        error,
        RunEngineError::Refused(RunRefusal::AlreadyEnded { .. })
    ) || matches!(
        error,
        RunEngineError::Refused(RunRefusal::InvalidTransition { from_state, .. })
            if from_state.is_terminal()
    )
}
