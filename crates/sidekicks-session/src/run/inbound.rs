//! The run engine's inbound dispatch: where each provider delivery is attributed to its execution
//! before anything is written. A turn boundary moves its binding to the next run position, and so
//! does a steer of one of the person's messages once its row is written; a steer of a message the
//! person never sent writes nothing and moves nothing. A lifecycle event, steer, child run, parent
//! correction, marker, live state, unstamped row or permission ask from the execution before an
//! undo's cut is absorbed there; one for a run already ended, a parent correction aside, which
//! lands on an ended run, is absorbed by the refusal of its own write, with a diagnostic unless it
//! is the provider's end of a turn the daemon interrupted or belongs to a helper refused at its
//! setup, and so is a piece of a reply or of reasoning once no turn of its ended run is open; any
//! other row is appended, stamped with its source pair when it is late, a reasoning update among
//! them with its body. A session notice or session row belongs to no execution and is appended as
//! it is, and so is a run's row that lands after its run, unstamped, whatever its binding's cursor
//! holds, unless the log shows its tool call opened in a turn an undo superseded: then it is
//! absorbed.

mod absorb;
#[cfg(test)]
pub(crate) mod tests;
mod work;

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
    SessionScopedRow, UnstampedRow, stamp,
};
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
use crate::run::engine::errors::RunEngineError;
use crate::run::engine::turns::guards::run_live_or_turn_open_statement;
use crate::run::engine::{RunEngine, ToolCallOpeningTurn};
use crate::run::epochs::{DeliveryAttribution, EpochBinding, EpochCursorError, ExecutionEpochs};
use crate::run::inbound::absorb::absorb;
use crate::run::inbound::work::RunWork;
use crate::run::provider_choice::ProviderChoiceResolver;
use crate::run::refusals::RunRefusal;
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
    /// Where a test holds an after-run row between the read of its opening's turn and its append.
    #[cfg(test)]
    pub(super) after_run_append_pause: PausePoint,
}

// A delivery attributed to its execution, with what is left to do for it.
enum Attributed {
    Settled(InboundOutcome),
    Append(Box<PendingAppend>),
    AfterRun(Box<AfterRunAppend>),
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
    // Events written just before it in the same write, in order, each with its body where it has
    // one: the earlier parts of a reasoning text too long for one entry, or the earlier accounts'
    // costs of one priced request.
    preceding_events: Vec<(SessionEvent, Option<String>)>,
    // On a piece of a reply or of reasoning, its run and where it arrived: its write is refused
    // once the run has ended and no turn of it is open, and the piece absorbed.
    piece_of: Option<PieceDelivery>,
}

// A run's row that lands after its run, with the tool call whose opening decides whether an undo
// took it: the call's own, or the one that started its command.
struct AfterRunAppend {
    binding_id: RuntimeBindingId,
    opening: Option<(RunId, String)>,
    session_id: SessionId,
    event: SessionEvent,
    content: Option<String>,
    source: Option<EpochPosition>,
}

impl AfterRunAppend {
    // The row's append, with the guard its opening's read hands it first in its write.
    fn pending(&self, guard: Option<WriteStatement>) -> PendingAppend {
        PendingAppend {
            session_id: self.session_id,
            event: self.event.clone(),
            linkage: SessionEventLinkage {
                transactional_prelude: guard.into_iter().collect(),
                ..body_linkage(self.content.clone())
            },
            source: self.source,
            preceding_events: Vec::new(),
            piece_of: None,
        }
    }
}

// Where a piece of a run's reply or reasoning arrived, to absorb it once its run has ended.
struct PieceDelivery {
    binding: EpochBinding,
    attribution: DeliveryAttribution,
    absorbed: AbsorbedDelivery,
}

// The prelude statement that refuses a piece's write once its run and every turn of it ended.
const PIECE_RUN_LIVE_GUARD_INDEX: usize = 0;

// The prelude statement that refuses an after-run row's write once a rollback of its run lands
// that the read of its opening's turn did not take.
const AFTER_RUN_ROLLBACK_GUARD_INDEX: usize = 0;

// A delivery on a binding that is absorbed when it comes from before a cut.
enum Absorbable {
    PermissionAsk,
    LiveRunState(RunSafetyBufferingUpdatedPayload),
    UnstampedRow(UnstampedRow),
    Run(RunWork),
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
            #[cfg(test)]
            after_run_append_pause: PausePoint::default(),
        }
    }

    /// Dispatches one delivery. It is attributed, and a live state published, when the call is
    /// made, before the returned future is first polled, so calls for a binding are made in its
    /// delivery order. A piece of a run being continued waits for the continue's write, so the
    /// caller must never await this future on the task that reads its provider's frames: a
    /// continue's start may wait on a frame behind the piece.
    /// Fails with [`InboundDispatchError::Cursor`] for a binding with no cursor open, on every
    /// delivery but an after-run row, with [`RunRefusal::NotFound`] for a piece of a run with no
    /// row, and with the engine's or the log's failure; a refusal for an ended run is an absorb,
    /// and a resend the engine owed after a move is logged, never failed.
    pub(crate) fn dispatch<'dispatch>(
        &'dispatch self,
        delivery: InboundDelivery<'_>,
    ) -> impl Future<Output = Result<InboundOutcome, InboundDispatchError>> + Send + use<'dispatch>
    {
        let attributed = self.attribute(delivery);
        async move {
            match attributed? {
                Attributed::Settled(outcome) => Ok(outcome),
                Attributed::Append(append) => self.append(*append).await,
                Attributed::AfterRun(after_run) => self.append_after_run(*after_run).await,
                Attributed::Run {
                    binding,
                    attribution,
                    work,
                } => self.run(&binding, attribution, *work).await,
            }
        }
    }

    // Appends `append`; a piece whose run and every turn of it ended is absorbed instead.
    async fn append(&self, append: PendingAppend) -> Result<InboundOutcome, InboundDispatchError> {
        let PendingAppend {
            session_id,
            event,
            mut linkage,
            source,
            preceding_events,
            piece_of,
        } = append;
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
        for (preceding, body) in preceding_events {
            let draft = SessionEventDraft::of_session(session_id, &preceding)?;
            linkage.preceding_events.push(match body {
                Some(body) => draft.with_content_body(body),
                None => draft,
            });
        }
        let draft = SessionEventDraft::of_session(session_id, &event)?;
        // Only a piece's write carries the live guard; another write's statement at its index
        // is the caller's own.
        let appended = self.appender.append(draft, linkage).await;
        let event_id = match (appended, piece_of.zip(piece_run_id)) {
            (Ok(receipt), _) => receipt.id,
            (Err(error), Some((piece, run_id)))
                if error.refused_statement_index() == Some(PIECE_RUN_LIVE_GUARD_INDEX) =>
            {
                self.engine.require_run(run_id).await?;
                return self
                    .absorb_ended(&piece.binding, &piece.absorbed, piece.attribution)
                    .await;
            }
            (Err(error), _) => return Err(error.into()),
        };
        Ok(match source {
            None => InboundOutcome::Appended { event_id },
            Some(source) => InboundOutcome::AppendedStamped { event_id, source },
        })
    }

    // Appends a run's row that lands after its run, unless its tool call opened in a turn an undo
    // superseded, which absorbs it as from before the cut, whatever its binding's cursor holds.
    // The append carries a guard that refuses it once a rollback of the run lands that the read
    // did not take, and the read then decides again; each refusal is a rollback the next read
    // takes, so the loop ends with the run's rollbacks.
    async fn append_after_run(
        &self,
        after_run: AfterRunAppend,
    ) -> Result<InboundOutcome, InboundDispatchError> {
        let Some((run_id, tool_call_id)) = &after_run.opening else {
            return self.append(after_run.pending(None)).await;
        };
        loop {
            let opening_turn = self
                .engine
                .read_tool_call_opening_turn(
                    after_run.session_id,
                    *run_id,
                    tool_call_id.clone(),
                    after_run.binding_id.clone(),
                )
                .await?;
            let no_newer_rollback = match opening_turn {
                ToolCallOpeningTurn::Cut { binding, source } => {
                    return Ok(absorb(
                        &binding,
                        &AbsorbedDelivery {
                            kind: "afterRunRow",
                            run_id: Some(*run_id),
                            new_state: None,
                        },
                        LateEventAbsorbReason::BeforeCut,
                        DeliveryAttribution::BeforeCut { source },
                    ));
                }
                ToolCallOpeningTurn::Kept { no_newer_rollback } => no_newer_rollback,
            };
            #[cfg(test)]
            self.after_run_append_pause.pass().await;
            match self
                .append(after_run.pending(Some(no_newer_rollback)))
                .await
            {
                Err(InboundDispatchError::Append(error))
                    if error.refused_statement_index() == Some(AFTER_RUN_ROLLBACK_GUARD_INDEX) => {}
                outcome => return outcome,
            }
        }
    }

    // Attributes `delivery` and settles what needs no write: a turn boundary, a delivery from
    // before a cut, a permission ask and a live state. A session notice, a row about the session or
    // the machine and a run's row that lands after its run are appended without attributing, the
    // last once its tool call's opening is read.
    fn attribute(&self, delivery: InboundDelivery<'_>) -> Result<Attributed, EpochCursorError> {
        let (binding, absorbable) = match delivery {
            InboundDelivery::SessionNotice { session_id, notice } => {
                let event = SessionEvent::SessionNoticePosted(notice);
                return Ok(appended(
                    session_id,
                    Vec::new(),
                    event,
                    SessionEventLinkage::default(),
                    None,
                ));
            }
            InboundDelivery::SessionEvent { row } => {
                let transactional_prelude = session_row_statements(&row);
                let (session_id, preceding, event) = row.into_events();
                let linkage = SessionEventLinkage {
                    transactional_prelude,
                    ..SessionEventLinkage::default()
                };
                return Ok(appended(session_id, preceding, event, linkage, None));
            }
            InboundDelivery::MachineEvent { row } => {
                let (session_id, event) = row.into_event();
                return Ok(appended(
                    session_id,
                    Vec::new(),
                    event,
                    SessionEventLinkage::default(),
                    None,
                ));
            }
            InboundDelivery::AfterRunRow {
                binding_id,
                row,
                content,
            } => {
                let opening = tool_call_opening_of(&row);
                let (session_id, event, source) = row.into_event(None);
                return Ok(Attributed::AfterRun(Box::new(AfterRunAppend {
                    binding_id,
                    opening,
                    session_id,
                    event,
                    content,
                    source,
                })));
            }
            InboundDelivery::TurnBoundary { binding_id } => {
                return self
                    .move_to_next_position(&binding_id)
                    .map(Attributed::Settled);
            }
            InboundDelivery::TurnSteered {
                binding_id,
                turn_number,
                message_id,
                cut_group_start,
            } => {
                let run_id = self.lock_epochs().binding(&binding_id)?.run_id;
                (
                    DeliveryBinding {
                        binding_id,
                        operation: None,
                    },
                    Absorbable::Run(RunWork::Steered {
                        run_id,
                        turn_number,
                        message_id,
                        cut_group_start,
                    }),
                )
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
                    preceding_events: Vec::new(),
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
                let preceding_events = parts
                    .into_iter()
                    .map(|part| {
                        let piece = SessionEvent::AgentThinkingUpdated(AgentOutputPayload::Run(
                            payload.clone(),
                        ));
                        (piece, Some(part.to_owned()))
                    })
                    .collect();
                let event = SessionEvent::AgentThinkingUpdated(AgentOutputPayload::Run(payload));
                return Ok(Attributed::Append(Box::new(PendingAppend {
                    session_id,
                    event,
                    linkage: body_linkage(Some(last)),
                    source,
                    preceding_events,
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
                subagent,
            } => (
                binding,
                Absorbable::Run(RunWork::ChildRun {
                    parent_run_id,
                    subagent,
                }),
            ),
            InboundDelivery::ChildRunParentCorrected {
                binding,
                child_run_id,
                parent_run_id,
            } => (
                binding,
                Absorbable::Run(RunWork::ParentCorrected {
                    child_run_id,
                    parent_run_id,
                }),
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
                appended(
                    session_id,
                    Vec::new(),
                    event,
                    SessionEventLinkage::default(),
                    None,
                )
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

    // Moves the binding to its next run position at a turn boundary; one from before a cut is
    // absorbed.
    fn move_to_next_position(
        &self,
        binding_id: &RuntimeBindingId,
    ) -> Result<InboundOutcome, EpochCursorError> {
        let mut epochs = self.lock_epochs();
        let attribution = epochs.move_to_next_position(binding_id)?;
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

    // Absorbs a delivery whose run had ended: one to a run its own record shows ended at its
    // setup, as a helper refused after its provider started it, is expected, so it is logged at
    // debug alone; any other is reported. Fails as the run's read fails.
    async fn absorb_ended(
        &self,
        binding: &EpochBinding,
        absorbed: &AbsorbedDelivery,
        attribution: DeliveryAttribution,
    ) -> Result<InboundOutcome, InboundDispatchError> {
        let run_id = absorbed.run_id.unwrap_or(binding.run_id);
        if self.engine.is_failed_at_setup(run_id).await? {
            tracing::debug!(
                %run_id,
                kind = absorbed.kind,
                "a delivery of a run refused at its setup was absorbed on its ended run"
            );
            return Ok(InboundOutcome::Absorbed {
                reason: LateEventAbsorbReason::RunEnded,
            });
        }
        Ok(absorb(
            binding,
            absorbed,
            LateEventAbsorbReason::RunEnded,
            attribution,
        ))
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
        | SessionScopedRow::UsageCostUpdated(_)
        | SessionScopedRow::OutputStyleChanged(_)
        | SessionScopedRow::GoalUpdated(_)
        | SessionScopedRow::GoalCleared(_) => Vec::new(),
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

// The run and tool call whose opening places a row that lands after its run: a held call's close
// or move to the background names its call, and a command's ending the call that started it.
fn tool_call_opening_of(row: &LateAppendableRow) -> Option<(RunId, String)> {
    let (run_id, tool_call_id) = match row {
        LateAppendableRow::AgentToolCallBackgrounded(payload) => {
            (payload.run_id, Some(&payload.tool_call_id))
        }
        LateAppendableRow::AgentToolCallCompleted(payload) => {
            (payload.run_id, payload.tool_call_id.as_ref())
        }
        LateAppendableRow::AgentToolCallFailed(payload) => {
            (payload.run_id, payload.tool_call_id.as_ref())
        }
        LateAppendableRow::AgentCommandEnded(payload) => {
            (payload.run_id, payload.tool_call_id.as_ref())
        }
        LateAppendableRow::AgentMessageSent(_)
        | LateAppendableRow::AgentToolCallInvoked(_)
        | LateAppendableRow::AgentSubagentStarted(_)
        | LateAppendableRow::AgentSubagentCompleted(_)
        | LateAppendableRow::SessionProviderStatusReported(_)
        | LateAppendableRow::UsageTokenCountRecorded(_)
        | LateAppendableRow::UsageContextWindowUpdated(_)
        | LateAppendableRow::UsageApiRequestRetried(_)
        | LateAppendableRow::AgentRunContextCompacted(_)
        | LateAppendableRow::AgentTurnRerouted(_) => return None,
    };
    Some((run_id, tool_call_id?.as_str().to_owned()))
}

// A row to append as it was attributed, after `preceding`, events with no body written before it
// in the same write.
fn appended(
    session_id: SessionId,
    preceding: Vec<SessionEvent>,
    event: SessionEvent,
    linkage: SessionEventLinkage,
    source: Option<EpochPosition>,
) -> Attributed {
    Attributed::Append(Box::new(PendingAppend {
        session_id,
        event,
        linkage,
        source,
        preceding_events: preceding
            .into_iter()
            .map(|preceding| (preceding, None))
            .collect(),
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
