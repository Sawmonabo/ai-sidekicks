//! A run's start on Claude Code: its opening words written to the session's live process as typed,
//! with its staged files, one turn at a time, after the output-speed level the run asks for is
//! applied. A turn the daemon starts itself (a goal, an `Allow once` with no run) or one
//! Claude Code started by itself is started as the session's own run through the run engine before
//! anything is written, at the session's current posture, so every row of the turn has a run; on a
//! session with no live process the run's binding opens one.

use std::error::Error;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::attachments::AttachmentResolver;
use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::attachments::{ClaudeAttachmentError, compose_claude_attachment_blocks};
use crate::driver::claude::delivery::stream::ClaudeSessionStreams;
use crate::driver::claude::handshake_register::ClaudeHandshakeRegister;
use crate::driver::claude::intervention::interrupt_claude_turn;
use crate::driver::claude::output_speed::{apply_claude_output_speed, resolve_claude_output_speed};
use crate::driver::claude::run::prompts::ClaudeSentPrompts;
use crate::driver::claude::run::routes::{ClaudeBoundRun, ClaudeRunRoute, ClaudeRunRoutes};
use crate::driver::claude::session::controls::claude_full_model_id;
use crate::driver::claude::session::errors::{
    ClaudeSessionError, ClaudeSessionUnavailableReason, is_unavailable_for,
};
use crate::driver::claude::session::idle_sleep::ClaudeIdleSleep;
use crate::driver::claude::session::slots::ClaudeSessionSlots;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
use crate::driver::claude::session::transport::user_message::{
    CLAUDE_RESET_REFUSAL_SENTENCE, ClaudeUserContentBlock, ClaudeWriteAttempt, ClaudeWriteDelivery,
    compose_claude_user_frame, is_reset_request, reset_refusal,
};
use crate::driver::claude::spawn::legs::assert_claude_spawn_bound_realization;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::{RunOpeningItem, StartRunParams};
use crate::driver::run_control::{
    DaemonTurnBindingError, DaemonTurnBindingResolver, DaemonTurnProcess, DriverRunRefusal,
};
use crate::outbound_text::{OutboundText, OutboundTextOrigin};
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::run_host::{DaemonTurnHeld, RunHost};
use crate::port::session_wake::SessionWaker;
use crate::run::start_request::DaemonTurnStartRequest;

/// What a turn the daemon starts on a session itself opens with: words, with the blocks of the
/// files a person's message carries, written to the session's own process under the message id a
/// later cut names; a command of Claude Code's own, written as words are only where the process
/// lists it; or the turn Claude Code started by itself, which its run takes with nothing written.
pub(crate) enum ClaudeDaemonTurnOpening {
    /// Words written to the session's process.
    Text {
        /// The words.
        text: OutboundText,
        /// The message's id.
        message_id: String,
        /// The blocks of its files, in staging order.
        attachment_blocks: Vec<ClaudeUserContentBlock>,
    },
    /// A command Claude Code runs, written only where the process's handshake lists `name`; one it
    /// does not list refuses the turn `CommandAbsent` before anything is held or written.
    Command {
        /// The command's name, bare, as the handshake lists it.
        name: &'static str,
        /// The command line, `/<name>` and its arguments.
        text: OutboundText,
        /// The message's id.
        message_id: String,
    },
    /// The turn Claude Code started by itself.
    Provider,
    /// Words the daemon tells the session's live, awake process only: with none live or the
    /// session asleep, the turn is refused `NoLiveSession` before anything wakes, opens or is
    /// written, and so is one whose process is let go before its binding, which opens none.
    Narration {
        /// The words.
        text: OutboundText,
        /// The message's id.
        message_id: String,
    },
}

/// Starts runs on live Claude Code sessions; clones share everything.
#[derive(Clone)]
pub(crate) struct ClaudeRunStart {
    /// Every session's slot.
    pub(crate) slots: ClaudeSessionSlots,
    /// The runs bound to each session.
    pub(crate) routes: Arc<ClaudeRunRoutes>,
    /// Each live session's stream.
    pub(crate) streams: Arc<ClaudeSessionStreams>,
    /// Each process's handshake, which settles a run's output speed.
    pub(crate) handshakes: Arc<ClaudeHandshakeRegister>,
    /// The messages written and not yet reported taken.
    pub(crate) prompts: Arc<Mutex<ClaudeSentPrompts>>,
    /// The run engine, which starts a turn the daemon starts itself and ends the runs a closed
    /// session held.
    pub(crate) engine: Arc<dyn RunHost>,
    /// The run engine's dispatch, which takes what the session's controls deliver.
    pub(crate) dispatch: Arc<dyn InboundDispatch>,
    /// Resolves a message's files.
    pub(crate) attachments: Arc<dyn AttachmentResolver>,
    /// Opens the binding of a turn the daemon starts itself.
    pub(crate) bindings: Arc<dyn DaemonTurnBindingResolver>,
    /// Which sessions the idle sleep stopped.
    pub(crate) idle_sleep: Arc<ClaudeIdleSleep>,
    /// The daemon's wake of a sleeping session, once registered.
    pub(crate) session_wakes: Arc<PortRegistration<Arc<dyn SessionWaker>>>,
}

impl ClaudeRunStart {
    /// Wakes the session where the idle sleep stopped it, answering once its process is up; a
    /// session awake goes on at once. Fails as the wake fails, the session left asleep.
    async fn wake_if_asleep(&self, session_id: SessionId) -> Result<(), DriverError> {
        if !self.idle_sleep.is_asleep(session_id) {
            return Ok(());
        }
        self.session_wakes
            .require_port()
            .map_err(|error| DriverError::Internal(Box::new(error)))?
            .wake_for_message(session_id)
            .await
            .map_err(DriverError::Internal)
    }

    /// Writes the run's opening words `text` to its session's live process, with the staged files
    /// `attachments`, waking the session first where it sleeps. Claude Code takes one turn at a
    /// time, so a run already holding the turn is refused `RunAlreadyDispatched` and one while
    /// another holds it `SessionTurnInFlight`; a run whose last turn an interrupt is ending first
    /// waits, within the request deadline, for that turn's end. Fails with no live session, a
    /// failed wake, a run the session's process cannot carry, files that cannot be read (before
    /// anything is held), and the failed write; nothing is resent. Words that would reset the
    /// session refuse the run, with nothing held or written.
    pub(crate) async fn start_run(
        &self,
        params: &StartRunParams,
        text: &OutboundText,
        attachments: &[ArtifactId],
    ) -> Result<(), DriverError> {
        let opening = &params.opening;
        let session_id = opening.session_id;
        let run_id = params.run_id;
        self.wake_if_asleep(session_id).await?;
        // Taken before the turn is read, so its release while this runs still wakes the wait.
        let mark = self.routes.turn_mark(session_id);
        let is_ending_for_interrupt = self
            .streams
            .get(session_id)
            .is_some_and(|stream| stream.is_turn_ending_for_interrupt(run_id));
        if is_ending_for_interrupt
            && self.routes.is_turn_held(session_id)
            && !self
                .routes
                .when_turn_changed_after(session_id, mark, CLAUDE_REQUEST_DEADLINE)
                .await
        {
            return Err(claude_session_unavailable(
                ClaudeSessionUnavailableReason::SessionTurnInFlight,
                session_id,
                Some(run_id),
            )
            .into());
        }
        let live = self.slots.live_session(session_id).ok_or_else(|| {
            claude_session_unavailable(
                ClaudeSessionUnavailableReason::NoLiveSession,
                session_id,
                Some(run_id),
            )
        })?;
        assert_claude_spawn_bound_realization(params, &live)?;
        // Read before the turn is held, so a file that cannot be read holds nothing; a picture
        // Claude Code refuses fails the run as that refusal.
        let attachment_blocks =
            compose_claude_attachment_blocks(&*self.attachments, &session_id, attachments)
                .await
                .map_err(|error| claude_attachment_failure(&live, error))?;
        if self
            .routes
            .lead_run_on(session_id)
            .is_some_and(|lead| lead.run_id == run_id)
        {
            return Err(claude_session_unavailable(
                ClaudeSessionUnavailableReason::RunAlreadyDispatched,
                session_id,
                Some(run_id),
            )
            .into());
        }
        // The next run carries the agent's own level, which differs and so is sent again.
        let output_speed = params
            .output_speed_for_turn
            .as_ref()
            .or(params.output_speed.as_ref())
            .map(|level| level.as_str().to_owned());
        self.open_turn(
            &live,
            ClaudeBoundRun {
                run_id,
                binding_id: opening.binding_id.clone(),
            },
            text,
            opening.message_id.to_string(),
            attachment_blocks,
            output_speed.as_deref(),
            matches!(opening.item, RunOpeningItem::Review { .. }),
        )
        .await?;
        Ok(())
    }

    /// Starts a turn the daemon starts on a session itself, or one Claude Code started by itself,
    /// as the session's own run, waking the session first where it sleeps, and answers the run's id
    /// once its opening is written and the run is running. A live process runs it at its current
    /// posture on its account; a session with no live process is admitted through the binding
    /// resolver, and the run's binding opens its process. A text or command opening is refused
    /// `SessionTurnInFlight`, before any run exists, while anything holds the session's turn, and
    /// so is any opening the run engine refuses for a turn it holds for another run; every opening
    /// on a live process holding no posture is refused `ExecutionPostureAbsent`, and a narration
    /// with no live, awake process `NoLiveSession`. Fails as the wake or the admission fails, and
    /// as the run engine's start fails, the run then ended `failed` by the engine; a refusal of the
    /// run's binding reaches the caller as that refusal.
    pub(crate) async fn start_daemon_turn(
        &self,
        session_id: SessionId,
        opening: ClaudeDaemonTurnOpening,
    ) -> Result<RunId, DriverError> {
        let is_live_only = matches!(opening, ClaudeDaemonTurnOpening::Narration { .. });
        if !is_live_only {
            self.wake_if_asleep(session_id).await?;
        }
        let live = self.slots.live_session(session_id);
        if is_live_only && (live.is_none() || self.idle_sleep.is_asleep(session_id)) {
            return Err(claude_session_unavailable(
                ClaudeSessionUnavailableReason::NoLiveSession,
                session_id,
                None,
            )
            .into());
        }
        let (admitted_provider_account_id, execution_posture) = if let Some(live) = live {
            let execution_posture =
                lock(&live.settings)
                    .execution_posture
                    .clone()
                    .ok_or_else(|| {
                        claude_session_unavailable(
                            ClaudeSessionUnavailableReason::ExecutionPostureAbsent,
                            session_id,
                            None,
                        )
                    })?;
            (live.admitted_provider_account_id(), execution_posture)
        } else {
            let admission = self
                .bindings
                .admit_daemon_turn(session_id)
                .await
                .map_err(daemon_turn_binding_failure)?;
            (
                admission.admitted_provider_account_id,
                admission.execution_posture,
            )
        };
        let is_provider_started = matches!(opening, ClaudeDaemonTurnOpening::Provider);
        if !is_provider_started && self.routes.is_turn_held(session_id) {
            return Err(claude_session_unavailable(
                ClaudeSessionUnavailableReason::SessionTurnInFlight,
                session_id,
                None,
            )
            .into());
        }
        let opening = Arc::new(Mutex::new(Some(opening)));
        let start = self.clone();
        let interrupt = self.clone();
        let request = DaemonTurnStartRequest {
            session_id,
            provider: DESCRIPTOR.provider_id(),
            admitted_provider_account_id,
            execution_posture,
            is_provider_started,
            start_turn: Box::new(move |run_id| {
                let start = start.clone();
                let opening = lock(&opening).take();
                async move { start.start_turn(session_id, run_id, opening).await }.boxed()
            }),
            interrupt_turn: Box::new(move |run_id| {
                let interrupt = interrupt.clone();
                async move {
                    let live = interrupt.live_session(session_id)?;
                    let stream = interrupt.streams.get(session_id);
                    interrupt_claude_turn(&live, stream.as_deref(), run_id).await?;
                    Ok(())
                }
                .boxed()
            }),
        };
        self.engine
            .start_daemon_turn(request)
            .await
            .map_err(|error| {
                if error.downcast_ref::<DaemonTurnHeld>().is_some() {
                    claude_session_unavailable(
                        ClaudeSessionUnavailableReason::SessionTurnInFlight,
                        session_id,
                        None,
                    )
                    .into()
                } else {
                    match error
                        .downcast::<DaemonTurnBindingError>()
                        .map(|binding| *binding)
                    {
                        // The process a narration needs was let go before its binding.
                        Ok(DaemonTurnBindingError::NoProviderSession { .. }) if is_live_only => {
                            claude_session_unavailable(
                                ClaudeSessionUnavailableReason::NoLiveSession,
                                session_id,
                                None,
                            )
                            .into()
                        }
                        Ok(binding) => daemon_turn_binding_failure(binding),
                        Err(error) => DriverError::Internal(error),
                    }
                }
            })
    }

    /// Runs `attempt`, and where it is refused because the session's turn is held, by a command,
    /// another run or a run whose end is not yet written, waits within the request deadline for
    /// the turn's next change and runs it once more. The mark is taken before the first try, so a
    /// change while it runs still wakes the wait. Fails `SessionTurnInFlight` when the turn does
    /// not change within the deadline or is still held at the second try, and as `attempt` fails.
    pub(crate) async fn retry_after_turn_change<T, Attempt>(
        &self,
        session_id: SessionId,
        attempt: impl Fn() -> Attempt,
    ) -> Result<T, DriverError>
    where
        Attempt: Future<Output = Result<T, DriverError>>,
    {
        let mark = self.routes.turn_mark(session_id);
        match attempt().await {
            Err(error)
                if is_unavailable_for(
                    &error,
                    ClaudeSessionUnavailableReason::SessionTurnInFlight,
                ) =>
            {
                if !self
                    .routes
                    .when_turn_changed_after(session_id, mark, CLAUDE_REQUEST_DEADLINE)
                    .await
                {
                    return Err(error);
                }
                attempt().await
            }
            done => done,
        }
    }

    // The engine's start of a daemon turn under its new run: the run's binding opened, which opens
    // a session's process where none is live but for a narration, then the opening carried out
    // once.
    async fn start_turn(
        &self,
        session_id: SessionId,
        run_id: RunId,
        opening: Option<ClaudeDaemonTurnOpening>,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        let process = if matches!(opening, Some(ClaudeDaemonTurnOpening::Narration { .. })) {
            DaemonTurnProcess::LiveOnly
        } else {
            DaemonTurnProcess::OpenWhenAbsent
        };
        let binding = self
            .bindings
            .open_daemon_turn_binding(run_id, session_id, process)
            .await?;
        let run = ClaudeBoundRun {
            run_id,
            binding_id: binding.binding_id,
        };
        let (text, message_id, attachment_blocks, command_name) = match opening {
            Some(ClaudeDaemonTurnOpening::Provider) => {
                self.routes
                    .hold_turn(run_id, session_id, run.binding_id.clone())
                    .map_err(|_held| {
                        claude_session_unavailable(
                            ClaudeSessionUnavailableReason::SessionTurnInFlight,
                            session_id,
                            Some(run_id),
                        )
                    })?;
                if let Some(live) = self.slots.live_session(session_id) {
                    live.record_served_binding(run.binding_id);
                }
                return Ok(());
            }
            Some(ClaudeDaemonTurnOpening::Text {
                text,
                message_id,
                attachment_blocks,
            }) => (text, message_id, attachment_blocks, None),
            Some(ClaudeDaemonTurnOpening::Command {
                name,
                text,
                message_id,
            }) => (text, message_id, Vec::new(), Some(name)),
            Some(ClaudeDaemonTurnOpening::Narration { text, message_id }) => {
                (text, message_id, Vec::new(), None)
            }
            // The engine starts each run's turn once.
            None => return Ok(()),
        };
        // Read again: the session may have closed or moved to another process meanwhile, or its
        // process was opened by the binding just now. A narration's process gone before the queue
        // let it go ends the run as the live-only binding would, so the start reads it typed.
        let Some(live) = self.slots.live_session(session_id) else {
            if process == DaemonTurnProcess::LiveOnly {
                return Err(Box::new(DaemonTurnBindingError::NoProviderSession {
                    session_id,
                }));
            }
            return Err(claude_session_unavailable(
                ClaudeSessionUnavailableReason::NoLiveSession,
                session_id,
                Some(run_id),
            )
            .into());
        };
        if let Some(name) = command_name
            && !self.lists_command(&live, name)
        {
            return Err(ClaudeSessionError::Unavailable {
                reason: ClaudeSessionUnavailableReason::CommandAbsent,
                detail: Some(format!("/{name}")),
                session_id: Some(session_id),
                run_id: Some(run_id),
            }
            .into());
        }
        self.open_turn(&live, run, &text, message_id, attachment_blocks, None, true)
            .await?;
        Ok(())
    }

    /// Whether the handshake of the process `live` runs lists the command `name`, bare; `false`
    /// before the process declared one.
    pub(crate) fn lists_command(&self, live: &LiveClaudeSession, name: &str) -> bool {
        self.handshakes
            .held_handshake_for(live.session_id, &live.provider_session_id)
            .is_some_and(|held| held.invocable_command_names.contains(name))
    }

    // Holds the session's turn for the run and writes its opening words and files, after the
    // output-speed level it asks for, recorded as the daemon's own where `is_daemons_opening`, as
    // a review's or a daemon turn's, which carries none of the person's words. The hold is taken
    // before any await, so it covers the level's request, and before the write, since an
    // interrupt racing the words must find the run. Words that would reset the session refuse the
    // run before anything is held, sent or recorded.
    #[expect(
        clippy::too_many_arguments,
        reason = "the session, the run, the opening's words, id and files, its level and its owner"
    )]
    async fn open_turn(
        &self,
        live: &Arc<LiveClaudeSession>,
        run: ClaudeBoundRun,
        text: &OutboundText,
        message_id: String,
        attachment_blocks: Vec<ClaudeUserContentBlock>,
        output_speed: Option<&str>,
        is_daemons_opening: bool,
    ) -> Result<(), DriverError> {
        if text.origin != OutboundTextOrigin::SystemNarration && is_reset_request(&text.text) {
            return Err(
                claude_run_refusal(live, CLAUDE_RESET_REFUSAL_SENTENCE.to_owned())
                    .unwrap_or_else(|| reset_refusal().into()),
            );
        }
        let ClaudeBoundRun { run_id, binding_id } = run;
        let session_id = live.session_id;
        self.routes
            .hold_turn(run_id, session_id, binding_id.clone())
            .map_err(|_held| {
                DriverError::from(claude_session_unavailable(
                    ClaudeSessionUnavailableReason::SessionTurnInFlight,
                    session_id,
                    Some(run_id),
                ))
            })?;
        live.record_served_binding(binding_id);
        if let Some(level) = output_speed {
            self.apply_output_speed(live, run_id, level).await?;
        }
        // Armed before the write, so the turn's handshake cannot outrun it; recorded before the
        // write, since Claude Code may report the message taken before the write returns.
        self.handshakes
            .arm_run_output_speed(session_id, &live.provider_session_id, run_id);
        {
            let mut prompts = lock(&self.prompts);
            prompts.record_written(session_id, run_id, &message_id, false);
            if is_daemons_opening {
                prompts.record_daemon_opening(session_id, &message_id);
            }
        }
        let frame = compose_claude_user_frame(text, message_id.clone(), attachment_blocks);
        match live.channel.write_user_frame(frame).await {
            ClaudeWriteAttempt::Written => Ok(()),
            ClaudeWriteAttempt::Failed { delivery, cause } => {
                self.handshakes.disarm_run_output_speed(session_id);
                // Bytes that may have been taken can still start a turn, whose end releases the
                // hold; a write that never left releases it now. Nothing is resent.
                Err(match delivery {
                    ClaudeWriteDelivery::Unsent => {
                        lock(&self.prompts).record_dropped(session_id, &message_id);
                        self.routes.unbind_run(run_id);
                        ClaudeSessionError::InputUnwritable(cause).into()
                    }
                    ClaudeWriteDelivery::Indeterminate => DriverError::Internal(Box::new(cause)),
                })
            }
        }
    }

    // Sends the run's output-speed level once, before the turn it governs, only when it differs
    // from the level the process took; a refusal runs the turn on the level the process holds.
    async fn apply_output_speed(
        &self,
        live: &Arc<LiveClaudeSession>,
        run_id: RunId,
        level: &str,
    ) -> Result<(), ClaudeSessionError> {
        let session_id = live.session_id;
        let applied = lock(&live.settings).applied_output_speed.clone();
        if applied.as_deref() == Some(resolve_claude_output_speed(level)) {
            return Ok(());
        }
        match apply_claude_output_speed(&*live.channel, session_id, level).await {
            Ok(Some(level)) => {
                lock(&live.settings).applied_output_speed = Some(level.to_owned());
            }
            Ok(None) => {}
            Err(error) => {
                self.routes.unbind_run(run_id);
                return Err(error);
            }
        }
        // A close or rewind during the request retired this process and its routes, so nothing is
        // armed or written on it.
        if !self
            .slots
            .live_session(session_id)
            .is_some_and(|current| Arc::ptr_eq(&current, live))
        {
            self.routes.unbind_run(run_id);
            return Err(claude_session_unavailable(
                ClaudeSessionUnavailableReason::NoLiveSession,
                session_id,
                Some(run_id),
            ));
        }
        Ok(())
    }

    /// The live process of a lead run or of a helper's child run. Fails `NoLiveRun` for a run
    /// apart from its session's process or bound to none.
    pub(crate) fn live_session_for_run(
        &self,
        run_id: RunId,
    ) -> Result<Arc<LiveClaudeSession>, ClaudeSessionError> {
        let session_id = match self.routes.route_of(run_id) {
            Some(ClaudeRunRoute::Lead { session_id, .. }) => Some(session_id),
            Some(ClaudeRunRoute::Child(route)) => Some(route.session_id),
            Some(ClaudeRunRoute::Apart) | None => None,
        };
        session_id
            .and_then(|session_id| self.slots.live_session(session_id))
            .ok_or(ClaudeSessionError::Unavailable {
                reason: ClaudeSessionUnavailableReason::NoLiveRun,
                detail: None,
                session_id,
                run_id: Some(run_id),
            })
    }

    /// The session's live process. Fails `NoLiveSession`.
    pub(crate) fn live_session(
        &self,
        session_id: SessionId,
    ) -> Result<Arc<LiveClaudeSession>, ClaudeSessionError> {
        self.slots.live_session(session_id).ok_or_else(|| {
            claude_session_unavailable(
                ClaudeSessionUnavailableReason::NoLiveSession,
                session_id,
                None,
            )
        })
    }
}

/// The refusal of an operation the session cannot carry out now, for `reason`.
pub(crate) fn claude_session_unavailable(
    reason: ClaudeSessionUnavailableReason,
    session_id: SessionId,
    run_id: Option<RunId>,
) -> ClaudeSessionError {
    ClaudeSessionError::Unavailable {
        reason,
        detail: None,
        session_id: Some(session_id),
        run_id,
    }
}

/// The failure a message's files that cannot be composed answer: a picture Claude Code refuses is
/// the run's refusal, naming the full id of the model the session runs; files that cannot be bound
/// or read, or a model id no refusal can carry, are internal.
pub(crate) fn claude_attachment_failure(
    live: &LiveClaudeSession,
    error: ClaudeAttachmentError,
) -> DriverError {
    error
        .picture_refusal()
        .and_then(|sentence| claude_run_refusal(live, sentence))
        .unwrap_or_else(|| DriverError::Internal(Box::new(error)))
}

// A daemon turn's admission or binding that failed: its refusal as the refusal a client reads by
// its code, and any other failure as internal.
fn daemon_turn_binding_failure(error: DaemonTurnBindingError) -> DriverError {
    match error {
        DaemonTurnBindingError::Refused { refusal, .. } => DriverError::Refused(refusal),
        error @ (DaemonTurnBindingError::NoProviderSession { .. }
        | DaemonTurnBindingError::NotAdmitted { .. }
        | DaemonTurnBindingError::BindingNotRecorded { .. }) => {
            DriverError::Internal(Box::new(error))
        }
    }
}

// The run's refusal in `sentence`, naming the full id of the model the session runs; none for a
// model id no refusal can carry.
fn claude_run_refusal(live: &LiveClaudeSession, sentence: String) -> Option<DriverError> {
    let running_model = lock(&live.settings).running_model.clone();
    let model = FreeFormText::new(claude_full_model_id(&live.initialize, &running_model)).ok()?;
    Some(DriverError::RunRefused(DriverRunRefusal {
        model,
        sentence,
    }))
}

#[cfg(test)]
mod tests;
