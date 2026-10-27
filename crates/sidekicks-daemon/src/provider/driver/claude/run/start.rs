//! A run's start on Claude Code: its opening words written to the session's live process as typed,
//! with its staged files, one turn at a time, after the output-speed level the run asks for is
//! applied. A turn the daemon starts itself (a goal, a review, an `Allow once` with no run) or one
//! Claude Code started by itself is started as the session's own run through the run engine before
//! anything is written, at the session's current posture, so every row of the turn has a run.

use std::error::Error;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::claude::DESCRIPTOR;
use crate::claude::attachments::{ClaudeAttachmentError, compose_claude_attachment_blocks};
use crate::claude::delivery::stream::ClaudeSessionStreams;
use crate::claude::handshake_register::ClaudeHandshakeRegister;
use crate::claude::intervention::interrupt_claude_turn;
use crate::claude::output_speed::{apply_claude_output_speed, resolve_claude_output_speed};
use crate::claude::run::prompts::ClaudeSentPrompts;
use crate::claude::run::routes::{ClaudeBoundRun, ClaudeRunRoute, ClaudeRunRoutes};
use crate::claude::session::controls::claude_full_model_id;
use crate::claude::session::errors::{ClaudeSessionError, ClaudeSessionUnavailableReason};
use crate::claude::session::slots::ClaudeSessionSlots;
use crate::claude::session::state::LiveClaudeSession;
use crate::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
use crate::claude::session::transport::user_message::{
    ClaudeUserContentBlock, ClaudeWriteAttempt, ClaudeWriteDelivery, compose_claude_user_frame,
};
use crate::claude::spawn::legs::assert_claude_spawn_bound_realization;
use crate::driver::attachments::AttachmentResolver;
use crate::driver::contract::{DriverError, StartRunParams};
use crate::driver::run_control::{DaemonTurnBindingResolver, DriverRunRefusal};
use crate::outbound_text::{OutboundText, OutboundTextOrigin};
use crate::port::inbound_dispatch::InboundDispatch;
use crate::port::run_host::RunHost;
use crate::run::start_request::DaemonTurnStartRequest;
use sidekicks_std::mutex_lock::lock;

/// What a turn the daemon starts on a session itself opens with: words, with the blocks of the
/// files a person's message carries, written to the session's own process under the message id a
/// later cut names; a turn run apart from that process, started once its run is bound; or the turn
/// Claude Code started by itself, which its run takes with nothing written.
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
    /// A turn run apart from the session's process.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start registers the Claude driver, whose staged review starts \
                      its own turn with it"
        )
    )]
    Apart {
        /// Starts the turn once its run is bound.
        start: Arc<dyn Fn(ClaudeBoundRun) + Send + Sync>,
    },
    /// The turn Claude Code started by itself.
    Provider,
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
}

impl ClaudeRunStart {
    /// Writes the run's opening words to its session's live process, as typed, with its staged
    /// files. Claude Code takes one turn at a time, so a run already holding the turn is refused
    /// `RunAlreadyDispatched` and one while another holds it `SessionTurnInFlight`; a run whose
    /// last turn an interrupt is ending first waits, within the request deadline, for that turn's
    /// end. Fails with no live session, a run the session's process cannot carry, files that
    /// cannot be read (before anything is held), and the failed write; nothing is resent.
    pub(crate) async fn start_run(&self, params: &StartRunParams) -> Result<(), DriverError> {
        let opening = &params.opening;
        let session_id = opening.session_id;
        let run_id = params.run_id;
        let is_ending_for_interrupt = self
            .streams
            .get(session_id)
            .is_some_and(|stream| stream.is_turn_ending_for_interrupt(run_id));
        if is_ending_for_interrupt
            && !self
                .routes
                .when_turn_released(session_id, CLAUDE_REQUEST_DEADLINE)
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
            compose_claude_attachment_blocks(&*self.attachments, &session_id, &opening.attachments)
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
            &OutboundText {
                text: opening.content.as_str().to_owned(),
                origin: OutboundTextOrigin::HumanText,
            },
            opening.message_id.to_string(),
            attachment_blocks,
            output_speed.as_deref(),
        )
        .await?;
        Ok(())
    }

    /// Starts a turn the daemon starts on a session itself, or one Claude Code started by itself,
    /// as the session's own run at its current posture, and answers the run's id once its opening
    /// is written and the run is running. A text opening is refused `SessionTurnInFlight`, before
    /// any run exists, while anything holds the session's turn; every opening is refused
    /// `ExecutionPostureAbsent` on a session holding no posture. Fails as the run engine's start
    /// fails, the run then ended `failed` by the engine.
    pub(crate) async fn start_daemon_turn(
        &self,
        session_id: SessionId,
        opening: ClaudeDaemonTurnOpening,
    ) -> Result<RunId, DriverError> {
        let live = self.live_session(session_id)?;
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
        let is_provider_started = matches!(opening, ClaudeDaemonTurnOpening::Provider);
        let is_apart = matches!(opening, ClaudeDaemonTurnOpening::Apart { .. });
        if matches!(opening, ClaudeDaemonTurnOpening::Text { .. })
            && self.routes.is_turn_held(session_id)
        {
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
            admitted_provider_account_id: live.admitted_provider_account_id.clone(),
            execution_posture,
            is_provider_started,
            is_apart,
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
            .map_err(DriverError::Internal)
    }

    // The engine's start of a daemon turn under its new run: the run's binding opened, then the
    // opening carried out once.
    async fn start_turn(
        &self,
        session_id: SessionId,
        run_id: RunId,
        opening: Option<ClaudeDaemonTurnOpening>,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        let binding = self
            .bindings
            .open_daemon_turn_binding(run_id, session_id)
            .await?;
        let run = ClaudeBoundRun {
            run_id,
            binding_id: binding.binding_id,
        };
        match opening {
            Some(ClaudeDaemonTurnOpening::Apart { start }) => start(run),
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
            }
            Some(ClaudeDaemonTurnOpening::Text {
                text,
                message_id,
                attachment_blocks,
            }) => {
                // Read again: the session may have closed or moved to another process meanwhile.
                let live = self.slots.live_session(session_id).ok_or_else(|| {
                    claude_session_unavailable(
                        ClaudeSessionUnavailableReason::NoLiveSession,
                        session_id,
                        Some(run_id),
                    )
                })?;
                self.open_turn(&live, run, &text, message_id, attachment_blocks, None)
                    .await?;
            }
            // The engine starts each run's turn once.
            None => {}
        }
        Ok(())
    }

    // Holds the session's turn for the run and writes its opening words and files, after the
    // output-speed level it asks for. The hold is taken before any await, so it covers the level's
    // request, and before the write, since an interrupt racing the words must find the run.
    async fn open_turn(
        &self,
        live: &Arc<LiveClaudeSession>,
        run: ClaudeBoundRun,
        text: &OutboundText,
        message_id: String,
        attachment_blocks: Vec<ClaudeUserContentBlock>,
        output_speed: Option<&str>,
    ) -> Result<(), DriverError> {
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
        lock(&self.prompts).record_written(session_id, run_id, &message_id, false);
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
    let running_model = lock(&live.settings).running_model.clone();
    let model = FreeFormText::new(claude_full_model_id(&live.initialize, &running_model)).ok();
    match (error.picture_refusal(), model) {
        (Some(sentence), Some(model)) => {
            DriverError::RunRefused(DriverRunRefusal { model, sentence })
        }
        (Some(_) | None, _) => DriverError::Internal(Box::new(error)),
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_contracts::agent::definition::AgentId;
    use sidekicks_contracts::artifacts::id::ArtifactId;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::run::queue::{MessageContent, QueueItemId};
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_contracts::wire::text::FreeFormText;

    use crate::claude::session::scripted::{
        SCRIPTED_PROVIDER_SESSION_ID, ScriptedSession, binding_id, settle,
    };
    use crate::driver::contract::{DriverError, RunOpening, StartRunParams};
    use crate::driver::run_control::{ResumeRunParams, WaitingMessage};
    use crate::driver::test_registry::new_run_id;

    // The opening of `run_id` on `session`'s lead binding, carrying `attachments`.
    fn opening_params(
        session: &ScriptedSession,
        run_id: RunId,
        attachments: Vec<ArtifactId>,
    ) -> StartRunParams {
        StartRunParams {
            run_id,
            opening: RunOpening {
                session_id: session.session_id,
                binding_id: binding_id("lead"),
                agent_id: AgentId::new(&mint_uuid_v7().to_string())
                    .expect("a minted UUID is an agent id"),
                content: FreeFormText::new("go on".to_owned()).expect("the words fit"),
                attachments,
                message_id: QueueItemId::new(&mint_uuid_v7().to_string())
                    .expect("a minted UUID is an item id"),
                skills: Vec::new(),
            },
            conversation_history: None,
            output_speed: None,
            options: Vec::new(),
            output_speed_for_turn: None,
            execution_posture: None,
            output_schema: None,
            step_bound: None,
        }
    }

    // Killed by answering a picture past Claude Code's limit as an internal failure, at a run's
    // start or as it continues, by dropping Claude Code's own words or the session's model from
    // the refusal, or by holding the session's turn for a run that never started.
    #[rstest]
    #[case::start(true)]
    #[case::resume(false)]
    #[tokio::test]
    async fn a_picture_past_the_limit_refuses_the_run_in_claude_codes_own_words(
        #[case] is_start: bool,
    ) {
        let session = ScriptedSession::new().await;
        let folder = tempfile::tempdir().expect("the test makes a temporary folder");
        let path = folder.path().join("screen.png");
        // Sparse: its size, which the limit reads, without its bytes.
        std::fs::File::create(&path)
            .and_then(|file| file.set_len(4_000_000))
            .expect("the test stores a large picture");
        let picture = session.attachments.picture(path);
        let run_id = new_run_id();

        let refused = if is_start {
            session
                .start
                .start_run(&opening_params(&session, run_id, vec![picture]))
                .await
        } else {
            session
                .parts
                .run_controls
                .resume_run(ResumeRunParams {
                    session_id: session.session_id,
                    run_id,
                    messages: vec![WaitingMessage {
                        id: QueueItemId::new(&mint_uuid_v7().to_string())
                            .expect("a minted UUID is an item id"),
                        content: MessageContent::new("go on".to_owned())
                            .expect("the words are a message"),
                        attachments: vec![picture],
                        skills: Vec::new(),
                    }],
                })
                .await
        };

        let Err(DriverError::RunRefused(refusal)) = refused else {
            panic!("a picture past the limit refuses the run, not {refused:?}");
        };
        assert_eq!(refusal.model.as_str(), "opus");
        assert_eq!(
            refusal.sentence,
            "screen.png: Image base64 size (5333336) exceeds API limit (5242880). Please resize \
             the image before sending."
        );
        assert_eq!(session.channel.user_frames(), [] as [serde_json::Value; 0]);
        assert!(
            session
                .start
                .routes
                .lead_run_on(session.session_id)
                .is_none()
        );
    }

    // Killed by releasing an ended turn's hold on the session's task: a continue of the run that
    // the interrupt stopped would wait on the task, which is itself waiting on that run's turn.
    #[tokio::test(start_paused = true)]
    async fn a_continued_run_starts_while_the_session_task_is_still_opening_its_last_turn() {
        let session = ScriptedSession::new().await;
        let run_id = session.hold_lead_turn("lead");
        session.stream.mark_interrupted(run_id);
        let turn_start = session.engine.hold_next_turn_start();
        session.frame(&json!({
            "type": "system",
            "subtype": "init",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        }));
        session.frame(&json!({
            "type": "result",
            "subtype": "error_during_execution",
            "is_error": true,
            "terminal_reason": "aborted_tools",
            "session_id": SCRIPTED_PROVIDER_SESSION_ID,
        }));
        settle().await;
        let params = opening_params(&session, run_id, Vec::new());
        let message_id = params.opening.message_id;

        session
            .start
            .start_run(&params)
            .await
            .expect("the run starts without waiting on the session's task");

        let written = session.channel.user_frames();
        assert_eq!(written.len(), 1);
        assert_eq!(written[0]["uuid"], message_id.to_string());
        drop(turn_start);
    }
}
