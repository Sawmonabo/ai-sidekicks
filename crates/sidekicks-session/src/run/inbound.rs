//! The run engine's inbound dispatch: where each provider delivery is attributed to its execution
//! before anything is written. A lifecycle event, child run, marker, live state, unstamped row or
//! permission ask from the execution before an undo's cut is absorbed there; one for a run already
//! ended is absorbed by the refusal of its own write, with a diagnostic unless it is the provider's
//! end of a turn the daemon interrupted, and so is a piece of a reply or of reasoning once no turn
//! of its ended run is open; any other row is appended, stamped with its source pair when it is
//! late, a reasoning update among them with its body. A session notice or session row belongs to
//! no execution and is appended as it is.

mod absorb;
#[cfg(test)]
pub(crate) mod tests;

use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::event::declared_variants::AgentOutputPayload;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::run::events::RunStateChangeState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::controls::events::RunSafetyBufferingUpdatedPayload;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::port::inbound_dispatch::InboundDispatch;
use sidekicks_provider::port::run_state_publisher::RunStatePublisher;
use sidekicks_provider::run::delivery::{
    DeliveryBinding, InboundDelivery, InboundOutcome, LateAppendableRow, LateEventAbsorbReason,
    RunMarker, SessionScopedRow, UnstampedRow, stamp,
};
use sidekicks_provider::run::state_entry::RunStateReport;
use sidekicks_provider::run::turn_end::ProviderTurnEnd;
use sidekicks_std::mutex_lock::lock;
#[cfg(test)]
use sidekicks_std::pause_point::PausePoint;
use sidekicks_store::database::statement::WriteStatement;
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

use crate::console_state::advisor_model_change_statement;
use crate::run::engine::turns::run_live_or_turn_open_statement;
use crate::run::engine::{RunEngine, RunEngineError};
use crate::run::epochs::{DeliveryAttribution, EpochBinding, EpochCursorError, ExecutionEpochs};
use crate::run::inbound::absorb::absorb;
use crate::run::provider_choice::ProviderChoiceResolver;
use crate::run::refusals::RunRefusal;
use crate::run::state_change::{RunStateChange, refused_statement_index};
use crate::transcript::reasoning::split_reasoning_text;

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
pub struct RunInboundDispatch {
    engine: Arc<RunEngine>,
    epochs: Arc<Mutex<ExecutionEpochs>>,
    run_state_publisher: Arc<dyn RunStatePublisher>,
    appender: SessionEventAppender,
    choices: Arc<ProviderChoiceResolver>,
    /// Where a test holds a held answer's settle between its failed try and its retry.
    #[cfg(test)]
    pub(super) settle_retry_pause: PausePoint,
}

// A delivery attributed to its execution, with what is left to do for it.
enum Attributed {
    Settled(InboundOutcome),
    Append(Box<PendingAppend>),
    Run {
        binding: EpochBinding,
        attribution: DeliveryAttribution,
        work: Box<RunWork>,
    },
}

// A row to append, with the pair it was stamped with, where it was.
struct PendingAppend {
    session_id: SessionId,
    event: SessionEvent,
    linkage: SessionEventLinkage,
    source: Option<EpochPosition>,
    // Events written just before it in the same write, each with its body: the earlier parts of a
    // reasoning text too long for one entry.
    preceding_pieces: Vec<(SessionEvent, String)>,
    // On a piece of a reply or of reasoning, its run and where it arrived: its write is refused
    // once the run has ended and no turn of it is open, and the piece absorbed.
    piece_of: Option<PieceDelivery>,
}

// Where a piece of a run's reply or reasoning arrived, to absorb it once its run has ended.
struct PieceDelivery {
    binding: EpochBinding,
    attribution: DeliveryAttribution,
    absorbed: AbsorbedDelivery,
}

// The prelude statement that refuses a piece's write once its run and every turn of it ended.
const PIECE_RUN_LIVE_GUARD_INDEX: usize = 0;

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
        change: RunStateReport,
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
    /// cursors keep, sending live states to `run_state_publisher`, appending rows to `event_log`
    /// and settling an answer `choices` holds once the provider reports its run.
    pub fn new(
        engine: Arc<RunEngine>,
        epochs: Arc<Mutex<ExecutionEpochs>>,
        run_state_publisher: Arc<dyn RunStatePublisher>,
        event_log: Arc<EventLogService>,
        choices: Arc<ProviderChoiceResolver>,
    ) -> Self {
        Self {
            engine,
            epochs,
            run_state_publisher,
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
            choices,
            #[cfg(test)]
            settle_retry_pause: PausePoint::default(),
        }
    }

    /// Dispatches one delivery. It is attributed, and a live state published, when the call is
    /// made, before the returned future is first polled, so calls for a binding are made in its
    /// delivery order. A piece of a run being continued waits for the continue's write, so the
    /// caller must never await this future on the task that reads its provider's frames: a
    /// continue's start may wait on a frame behind the piece.
    /// Fails with [`InboundDispatchError::Cursor`] for a binding with no cursor open, with
    /// [`RunRefusal::NotFound`] for a piece of a run with no row, and with the engine's or the
    /// log's failure; a refusal for an ended run is an absorb, and a resend the engine owed after
    /// a move is logged, never failed.
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
                    let PendingAppend {
                        session_id,
                        event,
                        mut linkage,
                        source,
                        preceding_pieces,
                        piece_of,
                    } = *append;
                    let piece_run_id = piece_of
                        .as_ref()
                        .map(|piece| piece.absorbed.run_id.unwrap_or(piece.binding.run_id));
                    if let Some(run_id) = &piece_run_id {
                        self.engine.wait_while_continuing(run_id).await;
                        let guard = run_live_or_turn_open_statement(run_id);
                        linkage
                            .transactional_prelude
                            .insert(PIECE_RUN_LIVE_GUARD_INDEX, guard);
                    }
                    for (piece, body) in preceding_pieces {
                        linkage.preceding_events.push(
                            SessionEventDraft::of_session(session_id, &piece)?
                                .with_content_body(body),
                        );
                    }
                    let draft = SessionEventDraft::of_session(session_id, &event)?;
                    let event_id = match self.appender.append(draft, linkage).await {
                        Ok(receipt) => receipt.id,
                        Err(error)
                            if refused_statement_index(&error)
                                == Some(PIECE_RUN_LIVE_GUARD_INDEX) =>
                        {
                            let (Some(piece), Some(run_id)) = (piece_of, piece_run_id) else {
                                return Err(error.into());
                            };
                            self.engine.require_run(run_id).await?;
                            return Ok(absorb(
                                &piece.binding,
                                &piece.absorbed,
                                LateEventAbsorbReason::RunEnded,
                                piece.attribution,
                            ));
                        }
                        Err(error) => return Err(error.into()),
                    };
                    Ok(match source {
                        None => InboundOutcome::Appended { event_id },
                        Some(source) => InboundOutcome::AppendedStamped { event_id, source },
                    })
                }
                Attributed::Run {
                    binding,
                    attribution,
                    work,
                } => self.run(&binding, attribution, *work).await,
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
                let transactional_prelude = session_row_statements(&row);
                let (session_id, event) = row.into_event();
                let linkage = SessionEventLinkage {
                    transactional_prelude,
                    ..SessionEventLinkage::default()
                };
                return Ok(appended(session_id, event, linkage, None));
            }
            InboundDelivery::MachineEvent { row } => {
                let (session_id, event) = row.into_event();
                return Ok(appended(
                    session_id,
                    event,
                    SessionEventLinkage::default(),
                    None,
                ));
            }
            InboundDelivery::TurnBoundary { binding_id } => {
                return self.open_turn(&binding_id).map(Attributed::Settled);
            }
            InboundDelivery::SessionRow {
                binding,
                row,
                content,
            } => {
                let (attribution, epoch_binding) = self.attribute_row(&binding)?;
                let piece_of = if let LateAppendableRow::AgentMessageSent(payload) = &row {
                    Some(PieceDelivery {
                        binding: epoch_binding,
                        attribution,
                        absorbed: AbsorbedDelivery {
                            kind: "sessionRow",
                            run_id: Some(payload.run_id),
                            new_state: None,
                        },
                    })
                } else {
                    None
                };
                let (session_id, event, source) = row.into_event(possible_source(attribution));
                return Ok(Attributed::Append(Box::new(PendingAppend {
                    session_id,
                    event,
                    linkage: body_linkage(content),
                    source,
                    preceding_pieces: Vec::new(),
                    piece_of,
                })));
            }
            InboundDelivery::ThinkingUpdate {
                binding,
                mut payload,
                content,
            } => {
                let (attribution, epoch_binding) = self.attribute_row(&binding)?;
                let source = stamp(
                    &mut payload.source_epoch,
                    &mut payload.source_position,
                    possible_source(attribution),
                );
                let piece_of = PieceDelivery {
                    binding: epoch_binding,
                    attribution,
                    absorbed: AbsorbedDelivery {
                        kind: "thinkingUpdate",
                        run_id: Some(payload.run_id),
                        new_state: None,
                    },
                };
                let session_id = payload.session_id;
                // A text longer than one reasoning entry is stored as consecutive pieces of its
                // row, written together.
                let mut parts = split_reasoning_text(&content);
                let last = parts
                    .pop()
                    .expect("a text splits into at least one part")
                    .to_owned();
                let preceding_pieces = parts
                    .into_iter()
                    .map(|part| {
                        let piece = SessionEvent::AgentThinkingUpdated(AgentOutputPayload::Run(
                            payload.clone(),
                        ));
                        (piece, part.to_owned())
                    })
                    .collect();
                let event = SessionEvent::AgentThinkingUpdated(AgentOutputPayload::Run(payload));
                return Ok(Attributed::Append(Box::new(PendingAppend {
                    session_id,
                    event,
                    linkage: body_linkage(Some(last)),
                    source,
                    preceding_pieces,
                    piece_of: Some(piece_of),
                })));
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
        let (attribution, epoch_binding) = self.attribute_row(&binding)?;
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
                work: Box::new(work),
            },
        })
    }

    // Attributes a delivery on `binding` to its execution, with the binding it arrived on.
    fn attribute_row(
        &self,
        binding: &DeliveryBinding<'_>,
    ) -> Result<(DeliveryAttribution, EpochBinding), EpochCursorError> {
        let mut epochs = self.lock_epochs();
        let attribution = epochs.attribute(&binding.binding_id, binding.operation)?;
        Ok((attribution, epochs.binding(&binding.binding_id)?.clone()))
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

    // Settles the answer the provider got with no reply back before the report that shows it took,
    // so the report finds the move made. A failed settle is tried once more; on a second failure
    // the answer stays held and the report still applies, so the run never reads waiting for input
    // while its provider runs. Answers whether the answer was left held that way.
    async fn settle_held_answer(&self, run_id: RunId, reported: RunState) -> bool {
        let mut settled = self.choices.settle_held_answer(run_id, reported).await;
        if settled.is_err() {
            #[cfg(test)]
            self.settle_retry_pause.pass().await;
            settled = self.choices.settle_held_answer(run_id, reported).await;
        }
        let Err(error) = settled else {
            return false;
        };
        tracing::warn!(
            run_id = %run_id,
            error = &error as &(dyn Error + 'static),
            "the answer held on a run's choice was not settled; it stays held and the provider's \
             report applies"
        );
        true
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
                let change = RunStateChange::from(change);
                let is_answer_left_held = self
                    .settle_held_answer(run_id, RunState::from(change.entry.state()))
                    .await;
                match self
                    .engine
                    .apply_provider_state_change(change, turn_end)
                    .await
                {
                    Ok(written) => {
                        // The report made the run's move, so the held answer settles alone.
                        if is_answer_left_held {
                            self.choices.hold_answer_as_settlement_alone(run_id);
                        }
                        InboundOutcome::Transitioned {
                            state: written.log_resend_failure(run_id).state,
                        }
                    }
                    // The end of a turn the daemon interrupted is expected to find the run ended.
                    Err(error) if is_ended_run_refusal(&error) && is_daemon_interrupt_end => {
                        InboundOutcome::Absorbed {
                            reason: LateEventAbsorbReason::RunEnded,
                        }
                    }
                    Err(error) if is_ended_run_refusal(&error) => run_ended(),
                    // A resume can land before the provider's own report of the pause it ends.
                    Err(error) if is_resumed_run_refusal(&error) => {
                        tracing::debug!(
                            error = &error as &(dyn Error + 'static),
                            run_id = %run_id,
                            "the provider's late report on a resumed run was absorbed"
                        );
                        InboundOutcome::Absorbed {
                            reason: LateEventAbsorbReason::RunResumed,
                        }
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            RunWork::Continued { run_id } => {
                match self.engine.continue_run_with_kept_messages(run_id).await? {
                    Some(run) => InboundOutcome::Transitioned { state: run.state },
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
        lock(&self.epochs)
    }
}

impl InboundDispatch for RunInboundDispatch {
    fn dispatch<'dispatch>(
        &'dispatch self,
        delivery: InboundDelivery<'_>,
    ) -> BoxFuture<'dispatch, Result<InboundOutcome, Box<dyn Error + Send + Sync>>> {
        // Attributed in this call, before the returned future is first polled.
        let dispatched = RunInboundDispatch::dispatch(self, delivery);
        async move { Ok(dispatched.await?) }.boxed()
    }
}

// The statements a row about the session commits with its event: a change of the session's own
// advisor moves the advisor's column, which every later launch reads.
fn session_row_statements(row: &SessionScopedRow) -> Vec<WriteStatement> {
    match row {
        SessionScopedRow::AdvisorChanged(payload) => vec![advisor_model_change_statement(
            &payload.session_id,
            payload.advisor_model.as_ref().map(FreeFormText::as_str),
            payload.at.as_str(),
        )],
        SessionScopedRow::SideQuestionAnswered(_)
        | SessionScopedRow::UsageTokenCountRecorded(_)
        | SessionScopedRow::OutputStyleChanged(_) => Vec::new(),
    }
}

// The pair a row of `attribution` is stamped with: none for the current execution; a row that may
// be from before the cut is stamped too, since a stamp only supersedes it.
fn possible_source(attribution: DeliveryAttribution) -> Option<EpochPosition> {
    match attribution {
        DeliveryAttribution::Current => None,
        DeliveryAttribution::BeforeCut { source } | DeliveryAttribution::Unknown { source } => {
            Some(source)
        }
    }
}

// A row to append as it was attributed.
fn appended(
    session_id: SessionId,
    event: SessionEvent,
    linkage: SessionEventLinkage,
    source: Option<EpochPosition>,
) -> Attributed {
    Attributed::Append(Box::new(PendingAppend {
        session_id,
        event,
        linkage,
        source,
        preceding_pieces: Vec::new(),
        piece_of: None,
    }))
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

// A provider's late `paused` or `running` report refused because a resume had already set the
// run running.
fn is_resumed_run_refusal(error: &RunEngineError) -> bool {
    matches!(
        error,
        RunEngineError::Refused(RunRefusal::InvalidTransition {
            from_state: RunState::Running,
            to_state: RunStateChangeState::Paused | RunStateChangeState::Running,
            ..
        })
    )
}
