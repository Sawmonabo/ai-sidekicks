//! The controls on a live Claude Code session as a whole, each answered on Claude Code's own
//! means: Build or Plan, the commands the daemon answers itself (the output style and the advisor
//! for this one session), a side question in a one-turn process that keeps nothing, Claude Code's
//! own review as the session's own run, and the live command list.

mod review;
mod staged_review;

use std::collections::HashMap;
use std::error::Error;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::future::BoxFuture;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::commands::ProviderCommandListResponse;
use sidekicks_contracts::session::controls::events::{
    SessionNotice, SessionNoticePostedPayload, SessionSideQuestionAnsweredPayload,
};
use sidekicks_contracts::session::controls::methods::{
    SessionMode, SideQuestionId, SideQuestionText,
};
use sidekicks_contracts::session::events::{
    SessionAdvisorChangedPayload, SessionOutputStyleChangedPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::{FreeFormText, TextError};
use sidekicks_platforms::PathRules;
use sidekicks_std::mutex_lock::lock;
use sidekicks_workspace::git::worktree::staged_changes::StagedChangesWorktrees;
use tokio_util::sync::CancellationToken;

use crate::driver::claude::DESCRIPTOR;
use crate::driver::claude::event_normalizer::is_claude_result_frame_kind;
use crate::driver::claude::run::start::ClaudeRunStart;
use crate::driver::claude::session::answered_commands::{
    ClaudeAnsweredCommand, ClaudeAttachedAdvisor, ClaudeCommandOutcome, answer_claude_advisor,
    answer_claude_output_style, read_claude_answered_command, read_claude_attached_advisor,
};
use crate::driver::claude::session::arrivals::deliver_in_session_order;
use crate::driver::claude::session::errors::{ClaudeSessionError, record_unheard_claude_failure};
use crate::driver::claude::session::permission_level::claude_permission_mode_for;
use crate::driver::claude::session::permissions::read_claude_session_rules;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeFlagSettings, ClaudePermissionMode, ClaudeSettingsReply,
};
use crate::driver::claude::session::transport::declarations::{
    ClaudeCumulativeUsageObservation, ClaudeInitializeDeclaration,
};
use crate::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::driver::claude::spawn::launch::bring_up::ClaudeSessionSpawn;
use crate::driver::claude::spawn::launch::installed_build::ClaudeProcessStarts;
use crate::driver::claude::spawn::launch::one_turn::{ClaudeOneTurnReply, ClaudeOneTurnRequest};
use crate::driver::claude::spawn::settings::ClaudeSessionAdvisor;
use crate::driver::contract::{DriverError, ProviderCommandsSubscription};
use crate::driver::diagnostics::DriverDiagnosticKind;
use crate::driver::error_causes::side_question_refusal;
use crate::driver::session_control::{ProviderCommandsListener, SessionCommandAnswer};
use crate::outbound_text::{OutboundText, OutboundTextOrigin};
use crate::port::in_process_tool_servers::InProcessToolServers;
use crate::port::session_rules::SessionRulePort;
use crate::port::usage_sink::UsageSink;
use crate::run::delivery::{InboundDelivery, InboundOutcome, SessionScopedRow};
use crate::usage_delta_accountant::{
    CumulativeUsageReading, ThreadBaseEstablishment, UsageDeltaAccountant,
};
use sidekicks_std::port_registration::PortRegistration;

/// Reads a session's command list as the driver answers it now; `None` before it holds one.
pub(crate) type ClaudeCommandListReader =
    Box<dyn Fn(SessionId) -> Option<ProviderCommandListResponse> + Send + Sync>;

// A review running as the session's own turn: its finish waits for its start notice, so the two
// always land in that order.
#[derive(Default)]
struct ClaudeReviewProgress {
    is_started_posted: bool,
    has_ended: bool,
}

// What the controls follow per session.
#[derive(Default)]
struct ClaudeControlTables {
    followers: HashMap<SessionId, HashMap<u64, ProviderCommandsListener>>,
    next_follower: u64,
    reviews: HashMap<SessionId, ClaudeReviewProgress>,
}

/// Build or Plan, style, advisor, side questions, reviews and the live command list.
pub(crate) struct ClaudeSessionControls {
    run_start: ClaudeRunStart,
    starts: Arc<dyn ClaudeProcessStarts>,
    staged_changes: StagedChangesWorktrees,
    session_rules: Arc<PortRegistration<Arc<dyn SessionRulePort>>>,
    in_process_tool_servers: Arc<PortRegistration<Arc<dyn InProcessToolServers>>>,
    read_commands: ClaudeCommandListReader,
    tables: Arc<Mutex<ClaudeControlTables>>,
}

/// The copy a side question runs on: the legs at the session's full model id, the account and the
/// conversation copied.
pub(crate) struct ClaudeSideQuestionCopy {
    /// The legs the copy starts on.
    pub(crate) legs: ClaudeSpawnBoundLegs,
    /// The account it runs on; `None` on the person's own home.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// The conversation copied, whose emitted usage the copy's is metered less.
    pub(crate) parent_provider_session_id: String,
}

impl ClaudeSessionControls {
    /// The controls, which start the session's own runs through `run_start`, its one-turn
    /// processes through `starts`, and read its command list through `read_commands`.
    pub(crate) fn new(
        run_start: ClaudeRunStart,
        starts: Arc<dyn ClaudeProcessStarts>,
        staged_changes: StagedChangesWorktrees,
        session_rules: Arc<PortRegistration<Arc<dyn SessionRulePort>>>,
        in_process_tool_servers: Arc<PortRegistration<Arc<dyn InProcessToolServers>>>,
        read_commands: ClaudeCommandListReader,
    ) -> Self {
        Self {
            run_start,
            starts,
            staged_changes,
            session_rules,
            in_process_tool_servers,
            read_commands,
            tables: Arc::new(Mutex::new(ClaudeControlTables::default())),
        }
    }

    /// Moves the session between Build and Plan from its next turn: Plan is Claude Code's `plan`
    /// mode and Build its level's own mode, stored once Claude Code takes it. Refused
    /// `session.mode.notOffered` in Claude Code's words when it refuses the mode; fails as the
    /// request fails.
    pub(crate) async fn update_session_mode(
        &self,
        live: &LiveClaudeSession,
        mode: SessionMode,
    ) -> Result<(), DriverError> {
        let level = lock(&live.settings)
            .execution_posture
            .as_ref()
            .map(ExecutionPosture::permission_level);
        let permission_mode = match mode {
            SessionMode::Plan => ClaudePermissionMode::Plan,
            SessionMode::Build => claude_permission_mode_for(level),
        };
        live.channel
            .send_control_request(ClaudeControlRequest::SetPermissionMode {
                mode: permission_mode,
            })
            .await
            .map_err(|error| {
                match error.into_refusal_as(
                    RefusalCode::SessionModeNotOffered,
                    "Claude Code refused the mode",
                ) {
                    Ok(refusal) => DriverError::Refused(refusal),
                    Err(error) => error.into(),
                }
            })?;
        lock(&live.settings).session_mode = mode;
        Ok(())
    }

    /// Answers typed text that is a command the daemon answers itself, for this session alone:
    /// `/output-style` and `/advisor` with a value the session takes apply it, stored, with a line
    /// only once Claude Code's settings confirm it; with none or another they list what the
    /// session holds; a `/config` key a control owns is answered with no line. Any other text goes
    /// as typed. Fails as Claude Code refuses the change.
    pub(crate) async fn answer_session_command(
        &self,
        live: &LiveClaudeSession,
        text: &str,
    ) -> Result<SessionCommandAnswer, ClaudeSessionError> {
        let Some(command) = read_claude_answered_command(text) else {
            return Ok(SessionCommandAnswer::NotAnswered {});
        };
        let choices = live.command_choices.clone().await;
        let line = match command {
            ClaudeAnsweredCommand::OutputStyle { argument } => {
                let current = lock(&live.settings)
                    .output_style
                    .clone()
                    .or_else(|| live.initialize.output_style.clone());
                match answer_claude_output_style(
                    &argument,
                    &live.initialize.output_styles,
                    current.as_deref(),
                    &choices.output_styles,
                ) {
                    ClaudeCommandOutcome::Apply(style) => self
                        .set_output_style(live, &style)
                        .await?
                        .then(|| format!("Output style set to {style}.")),
                    ClaudeCommandOutcome::Listing { line } => Some(line),
                }
            }
            ClaudeAnsweredCommand::Advisor { argument } => {
                let (current, attached) = {
                    let settings = lock(&live.settings);
                    (
                        settings.advisor.model().map(str::to_owned),
                        settings.attached_advisor.clone(),
                    )
                };
                let display_name = |model: &str| display_name_of(live, model);
                match answer_claude_advisor(
                    &argument,
                    current.as_deref(),
                    &attached,
                    &choices.advisor,
                    &display_name,
                ) {
                    ClaudeCommandOutcome::Apply(advisor) => {
                        let attached = self.set_advisor_model(live, advisor.as_deref()).await?;
                        confirmed_advisor_line(live, advisor.as_deref(), &attached)
                    }
                    ClaudeCommandOutcome::Listing { line } => Some(line),
                }
            }
            ClaudeAnsweredCommand::Config => None,
        };
        Ok(SessionCommandAnswer::Answered { line })
    }

    /// Asks `question` on the copy of the conversation `copy` composes, in a one-turn process in
    /// plan mode that keeps nothing, and resolves once it is answered: the answer is appended as a
    /// row, its usage metered on the session through `usage` less the copied conversation's own.
    /// Refused `session.sideQuestion.refused` when the model refuses the question; fails as the
    /// copy cannot be composed or its turn fails, and when its words cannot be stored.
    pub(crate) async fn ask_side_question(
        &self,
        session_id: SessionId,
        side_question_id: SideQuestionId,
        question: String,
        copy: BoxFuture<'static, Result<ClaudeSideQuestionCopy, Box<dyn Error + Send + Sync>>>,
        usage: &PortRegistration<Arc<dyn UsageSink>>,
    ) -> Result<(), DriverError> {
        let reply = self
            .run_side_question(copy, question.clone(), usage)
            .await?;
        let row = side_question_row(session_id, side_question_id, question, reply)?;
        self.deliver(session_id, InboundDelivery::SessionEvent { row })
            .await;
        Ok(())
    }

    /// Follows the session's live command list: the listener gets the current list now and each
    /// new one the session's process declares, until the subscription drops.
    pub(crate) fn subscribe_provider_commands(
        &self,
        session_id: SessionId,
        listener: ProviderCommandsListener,
    ) -> ProviderCommandsSubscription {
        let first = Arc::clone(&listener);
        let follower = {
            let mut tables = self.lock();
            let follower = tables.next_follower;
            tables.next_follower += 1;
            tables
                .followers
                .entry(session_id)
                .or_default()
                .insert(follower, listener);
            follower
        };
        if let Some(current) = (self.read_commands)(session_id) {
            first(current);
        }
        let tables = Arc::clone(&self.tables);
        ProviderCommandsSubscription::new(move || {
            let mut tables = lock(&tables);
            if let Some(followers) = tables.followers.get_mut(&session_id) {
                followers.remove(&follower);
                if followers.is_empty() {
                    tables.followers.remove(&session_id);
                }
            }
        })
    }

    /// Reads one frame of the session's own thread on its task: a new `system/init` gives the
    /// followers the new list, and a `result` finishes a review running as the session's turn.
    pub(crate) async fn observe_lead_frame(&self, session_id: SessionId, frame_kind: &str) {
        if frame_kind == "system/init" {
            let listeners: Vec<_> = self
                .lock()
                .followers
                .get(&session_id)
                .map(|followers| followers.values().cloned().collect())
                .unwrap_or_default();
            // Read only for a session someone follows, since each read checks every entry again.
            if !listeners.is_empty()
                && let Some(current) = (self.read_commands)(session_id)
            {
                for listener in &listeners {
                    listener(current.clone());
                }
            }
            return;
        }
        if is_claude_result_frame_kind(frame_kind) {
            self.finish_review(session_id).await;
        }
    }

    /// Forgets a session whose process is gone: its review ended with it, its followers stay.
    pub(crate) async fn forget_process(&self, session_id: SessionId) {
        self.finish_review(session_id).await;
    }

    /// Forgets a closed session's review and followers.
    pub(crate) async fn forget_session(&self, session_id: SessionId) {
        self.finish_review(session_id).await;
        self.lock().followers.remove(&session_id);
    }

    // A review running as the session's turn ended: finished now if its start notice went, else
    // once it does.
    async fn finish_review(&self, session_id: SessionId) {
        let is_posted = {
            let mut tables = self.lock();
            match tables.reviews.get_mut(&session_id) {
                Some(review) if review.is_started_posted => {
                    tables.reviews.remove(&session_id);
                    true
                }
                Some(review) => {
                    review.has_ended = true;
                    false
                }
                None => false,
            }
        };
        if is_posted {
            self.post_notice(session_id, SessionNotice::ReviewFinished { session_id })
                .await;
        }
    }

    // Every later process of the session starts with the style, and the change is stored; answers
    // whether `get_settings` then shows the style in effect, the only ground for saying it is set.
    async fn set_output_style(
        &self,
        live: &LiveClaudeSession,
        output_style: &str,
    ) -> Result<bool, ClaudeSessionError> {
        live.channel
            .send_control_request(ClaudeControlRequest::ApplyFlagSettings {
                settings: ClaudeFlagSettings {
                    output_style: Some(output_style.to_owned()),
                    ..ClaudeFlagSettings::default()
                },
            })
            .await?;
        lock(&live.settings).output_style = Some(output_style.to_owned());
        let settings = live
            .channel
            .send_control_request(ClaudeControlRequest::GetSettings {})
            .await?;
        if let Ok(output_style) = FreeFormText::new(output_style.to_owned()) {
            let row = SessionScopedRow::OutputStyleChanged(SessionOutputStyleChangedPayload {
                session_id: live.session_id,
                output_style,
                at: WireInstant::now(),
            });
            self.deliver(live.session_id, InboundDelivery::SessionEvent { row })
                .await;
        }
        let reply = ClaudeSettingsReply::read(settings.response.as_deref());
        Ok(effective_output_style(&reply) == Some(output_style))
    }

    // Off is Claude Code's own empty advisor, never `null`, which would let the person's own
    // advisor through; every later process of the session starts with it, and the change is
    // stored. Answers what Claude Code will attach after it.
    async fn set_advisor_model(
        &self,
        live: &LiveClaudeSession,
        advisor_model: Option<&str>,
    ) -> Result<ClaudeAttachedAdvisor, ClaudeSessionError> {
        live.channel
            .send_control_request(ClaudeControlRequest::ApplyFlagSettings {
                settings: ClaudeFlagSettings {
                    advisor_model: ClaudeSessionAdvisor::of(advisor_model).setting(),
                    ..ClaudeFlagSettings::default()
                },
            })
            .await?;
        let settings = live
            .channel
            .send_control_request(ClaudeControlRequest::GetSettings {})
            .await?;
        let attached =
            read_claude_attached_advisor(&ClaudeSettingsReply::read(settings.response.as_deref()));
        {
            let mut held = lock(&live.settings);
            held.advisor = ClaudeSessionAdvisor::of(advisor_model);
            held.attached_advisor = attached.clone();
        }
        let attached_advisor_model = match &attached {
            ClaudeAttachedAdvisor::Attached { model } => {
                Some(FreeFormText::new(model.clone()).ok())
            }
            ClaudeAttachedAdvisor::Detached => Some(None),
            ClaudeAttachedAdvisor::Unreported => None,
        };
        let row = SessionScopedRow::AdvisorChanged(SessionAdvisorChangedPayload {
            session_id: live.session_id,
            advisor_model: advisor_model.and_then(|model| FreeFormText::new(model.to_owned()).ok()),
            attached_advisor_model,
            at: WireInstant::now(),
        });
        self.deliver(live.session_id, InboundDelivery::SessionEvent { row })
            .await;
        Ok(attached)
    }

    // The side question's one turn on its copy, and its usage metered once the model answered.
    async fn run_side_question(
        &self,
        copy: BoxFuture<'static, Result<ClaudeSideQuestionCopy, Box<dyn Error + Send + Sync>>>,
        question: String,
        usage: &PortRegistration<Arc<dyn UsageSink>>,
    ) -> Result<ClaudeOneTurnReply, DriverError> {
        let copy = copy.await.map_err(DriverError::Internal)?;
        let reply = self
            .run_one_turn(
                &copy.legs,
                copy.provider_account_id.clone(),
                Some(copy.parent_provider_session_id.clone()),
                Some(ClaudePermissionMode::Plan),
                question,
                CancellationToken::new(),
            )
            .await?;
        meter_side_question(
            usage,
            copy.legs.session_id,
            &copy.parent_provider_session_id,
            reply.usage.as_ref(),
        );
        Ok(reply)
    }

    // Runs one unkept turn on `legs` with the session's rules, the words given as the daemon's,
    // in `permission_mode` where given and else the level's own.
    async fn run_one_turn(
        &self,
        legs: &ClaudeSpawnBoundLegs,
        provider_account_id: Option<ProviderAccountId>,
        resume_handle: Option<String>,
        permission_mode: Option<ClaudePermissionMode>,
        text: String,
        stop: CancellationToken,
    ) -> Result<ClaudeOneTurnReply, ClaudeLaunchError> {
        let session_rules = read_claude_session_rules(&self.session_rules, legs.session_id)
            .await
            .map_err(|error| ClaudeLaunchError::Build(DriverError::Internal(error)))?;
        let in_process_servers = self.in_process_tool_servers.port();
        self.starts
            .run_one_turn(ClaudeOneTurnRequest {
                spawn: ClaudeSessionSpawn {
                    legs,
                    provider_account_id,
                    session_rules: &session_rules,
                    step_bound: None,
                    in_process_servers,
                    path_rules: PathRules::NATIVE,
                },
                resume_handle,
                permission_mode,
                text: OutboundText {
                    text,
                    origin: OutboundTextOrigin::DriverCommand,
                },
                stop,
            })
            .await
    }

    // Delivers in order with the session's rows: in place on its own task, else through its
    // queue, else, with no process left to order it, straight to the run engine.
    async fn deliver(
        &self,
        session_id: SessionId,
        delivery: InboundDelivery<'static>,
    ) -> Option<InboundOutcome> {
        deliver_in_session_order(
            &*self.run_start.dispatch,
            &self.run_start.streams,
            session_id,
            delivery,
        )
        .await
    }

    async fn post_notice(&self, session_id: SessionId, notice: SessionNotice) {
        drop(
            self.deliver(
                session_id,
                InboundDelivery::SessionNotice {
                    session_id,
                    notice: SessionNoticePostedPayload::Notice(notice),
                },
            )
            .await,
        );
    }

    fn lock(&self) -> MutexGuard<'_, ClaudeControlTables> {
        lock(&self.tables)
    }
}

/// The legs a one-turn process of `live`'s session starts on: its own, at the level, advisor and
/// style it runs with now, on the full id of the model it runs, in `working_directory` where one is
/// given.
pub(crate) fn one_turn_legs(
    live: &LiveClaudeSession,
    working_directory: Option<std::path::PathBuf>,
) -> ClaudeSpawnBoundLegs {
    let settings = lock(&live.settings).clone();
    ClaudeSpawnBoundLegs {
        model: claude_full_model_id(&live.initialize, &settings.running_model),
        execution_posture: settings.execution_posture,
        advisor: settings.advisor,
        output_style: settings.output_style,
        working_directory: working_directory
            .unwrap_or_else(|| live.spawn_bound_legs.working_directory.clone()),
        ..live.spawn_bound_legs.clone()
    }
}

/// The full id of `model` as `declaration` offers it, since plan mode runs an alias as another
/// model; `model` as given where the build offers it under no full id.
pub(crate) fn claude_full_model_id(
    declaration: &ClaudeInitializeDeclaration,
    model: &str,
) -> String {
    declaration
        .offered_model(model)
        .and_then(|offered| offered.resolved_model.clone())
        .unwrap_or_else(|| model.to_owned())
}

// The copy's usage on the session less what the copied conversation already reported: the copy
// meters as a resumed thread of its own whose base is the conversation's emitted sums. With no
// usage record registered it goes nowhere; a base that cannot be read is recorded and nothing is
// metered, since the copy's whole figure would count the conversation again.
fn meter_side_question(
    usage: &PortRegistration<Arc<dyn UsageSink>>,
    session_id: SessionId,
    parent_provider_session_id: &str,
    observed: Option<&ClaudeCumulativeUsageObservation>,
) {
    let (Some(observed), Some(sink)) = (observed, usage.port()) else {
        return;
    };
    let base = match sink.read_prior_emitted(session_id, parent_provider_session_id) {
        Ok(base) => base,
        Err(error) => {
            record_unheard_claude_failure(
                DriverDiagnosticKind::UsageResumeBaseUnavailable,
                session_id,
                "the side question's usage base",
                &*error,
            );
            return;
        }
    };
    let thread_id = mint_uuid_v7().to_string();
    let mut accountant = UsageDeltaAccountant::new(DESCRIPTOR.provider_id());
    accountant.establish_thread(
        thread_id.clone(),
        ThreadBaseEstablishment::Resume {
            prior_emitted_cumulative: base,
        },
    );
    if let Some(metered) = accountant.meter_reading(CumulativeUsageReading {
        thread_id,
        named_turn_id: None,
        cumulative: observed.cumulative,
        declared_per_turn: observed.declared_per_turn,
    }) {
        sink.record_metered(session_id, metered);
    }
}

// The answered row of a side question; refused `session.sideQuestion.refused`, the refusal as the
// provider gave it in its detail, when the model refused it, and a fault when the question or the
// answer is blank, holds a NUL or passes the cap.
fn side_question_row(
    session_id: SessionId,
    side_question_id: SideQuestionId,
    question: String,
    reply: ClaudeOneTurnReply,
) -> Result<SessionScopedRow, DriverError> {
    if let Some(cause) = reply.refusal {
        return Err(DriverError::Refused(side_question_refusal(
            session_id,
            side_question_id,
            &cause,
        )));
    }
    let unstorable = |error: TextError| DriverError::Internal(Box::new(error));
    let question = FreeFormText::new(question).map_err(unstorable)?;
    let answer = FreeFormText::new(reply.text).map_err(unstorable)?;
    Ok(SessionScopedRow::SideQuestionAnswered(
        SessionSideQuestionAnsweredPayload {
            session_id,
            side_question_id,
            question: SideQuestionText(question),
            answer,
        },
    ))
}

// The name Claude Code's own lines give a model: the name `initialize` shows for the alias or
// full id, else the model as given.
fn display_name_of(live: &LiveClaudeSession, model: &str) -> String {
    live.initialize
        .offered_model(model)
        .and_then(|offered| offered.display_name.clone())
        .unwrap_or_else(|| model.to_owned())
}

// The line after an applied advisor change, only once Claude Code's settings name that advisor,
// or none for off, so the line never names an advisor the session will not get.
fn confirmed_advisor_line(
    live: &LiveClaudeSession,
    requested: Option<&str>,
    attached: &ClaudeAttachedAdvisor,
) -> Option<String> {
    match (requested, attached) {
        (None, ClaudeAttachedAdvisor::Detached) => Some("Advisor off.".to_owned()),
        (Some(requested), ClaudeAttachedAdvisor::Attached { model }) => {
            let requested_name = display_name_of(live, requested);
            (display_name_of(live, model) == requested_name)
                .then(|| format!("Advisor set to {requested_name}."))
        }
        (None | Some(_), _) => None,
    }
}

// The output style a `get_settings` reply says is in effect.
fn effective_output_style(reply: &ClaudeSettingsReply) -> Option<&str> {
    reply.effective.as_ref()?.get("outputStyle")?.as_str()
}
