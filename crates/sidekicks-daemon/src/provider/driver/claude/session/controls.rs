//! The controls on a live Claude Code session as a whole, each answered on Claude Code's own
//! means: Build or Plan, the commands the daemon answers itself (the output style and the advisor
//! for this one session), a side question in a one-turn process that keeps nothing, Claude Code's
//! own review as the session's own run, and the live command list.

mod staged_review;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Deserialize;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::driver::commands::ProviderCommandListResponse;
use sidekicks_contracts::session::controls::events::{
    SessionNotice, SessionNoticePostedPayload, SessionSideQuestionAnsweredPayload,
};
use sidekicks_contracts::session::controls::methods::{
    SessionMode, SessionReviewTarget, SideQuestionId, SideQuestionText,
};
use sidekicks_contracts::session::events::{
    SessionAdvisorChangedPayload, SessionOutputStyleChangedPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_platforms::PathRules;
use tokio_util::sync::CancellationToken;

use crate::git::worktree::staged_changes::StagedChangesWorktrees;
use crate::provider::driver::claude::run::start::{
    ClaudeDaemonTurnOpening, ClaudeRunStart, claude_session_unavailable,
};
use crate::provider::driver::claude::session::answered_commands::{
    ClaudeAnsweredCommand, ClaudeAttachedAdvisor, ClaudeCommandOutcome, answer_claude_advisor,
    answer_claude_output_style, read_claude_answered_command, read_claude_attached_advisor,
};
use crate::provider::driver::claude::session::arrivals::{
    ClaudeDeliveryPlace, deliver_in_current_place,
};
use crate::provider::driver::claude::session::errors::{
    ClaudeSessionError, ClaudeSessionUnavailableReason, record_unheard_claude_failure,
};
use crate::provider::driver::claude::session::permission_level::{
    claude_permission_mode_for, permission_level_of,
};
use crate::provider::driver::claude::session::permissions::read_claude_session_rules;
use crate::provider::driver::claude::session::state::LiveClaudeSession;
use crate::provider::driver::claude::session::transport::control::{
    ClaudeControlRequest, ClaudeFlagSettings, ClaudePermissionMode,
};
use crate::provider::driver::claude::session::transport::spawn_legs::ClaudeSpawnBoundLegs;
use crate::provider::driver::claude::spawn::launch::ClaudeLaunchError;
use crate::provider::driver::claude::spawn::launch::bring_up::ClaudeSessionSpawn;
use crate::provider::driver::claude::spawn::launch::installed_build::ClaudeProcessStarts;
use crate::provider::driver::claude::spawn::launch::one_turn::{
    ClaudeOneTurnReply, ClaudeOneTurnRequest,
};
use crate::provider::driver::claude::spawn::settings::claude_advisor_setting;
use crate::provider::driver::contract::{DriverError, ProviderCommandsSubscription};
use crate::provider::driver::diagnostics::DriverDiagnosticKind;
use crate::provider::driver::session_control::{ProviderCommandsListener, SessionCommandAnswer};
use crate::provider::outbound_text::{OutboundText, OutboundTextOrigin};
use crate::provider::port::in_process_tool_servers::InProcessToolServers;
use crate::provider::port::registration::PortRegistration;
use crate::provider::port::session_rules::SessionRulePort;
use crate::session::run::inbound::rows::SessionScopedRow;
use crate::session::run::inbound::{InboundDelivery, InboundOutcome};

// The bundled skill Claude Code's review runs, by the name the build's skill list gives it.
const CLAUDE_REVIEW_SKILL_NAME: &str = "code-review";

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

// A `get_settings` reply's `effective` member, of which only the output style is read.
#[derive(Deserialize)]
struct SettingsReply {
    #[serde(default)]
    effective: Option<EffectiveSettings>,
}

#[derive(Deserialize)]
struct EffectiveSettings {
    #[serde(default, rename = "outputStyle")]
    output_style: Option<String>,
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
    /// mode and Build its level's own mode, stored once Claude Code takes it. Fails as Claude Code
    /// refuses.
    pub(crate) async fn update_session_mode(
        &self,
        live: &LiveClaudeSession,
        mode: SessionMode,
    ) -> Result<(), ClaudeSessionError> {
        let level = lock(&live.settings)
            .execution_posture
            .as_ref()
            .map(permission_level_of);
        let permission_mode = match mode {
            SessionMode::Plan => ClaudePermissionMode::Plan,
            SessionMode::Build => claude_permission_mode_for(level),
        };
        live.channel
            .send_control_request(ClaudeControlRequest::SetPermissionMode {
                mode: permission_mode,
            })
            .await?;
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
                        settings.advisor_model.clone(),
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

    /// Asks `question` on a copy of the conversation in a one-turn process on the session's full
    /// model id, which keeps nothing; returns at once, its answer appended as a row when it comes
    /// and a refusal or failure recorded.
    pub(crate) fn ask_side_question(
        self: &Arc<Self>,
        live: &Arc<LiveClaudeSession>,
        side_question_id: SideQuestionId,
        question: String,
    ) {
        let (controls, live) = (Arc::clone(self), Arc::clone(live));
        tokio::spawn(async move {
            let session_id = live.session_id;
            let legs = one_turn_legs(&live, None);
            let reply = controls
                .run_one_turn(
                    &live,
                    &legs,
                    Some(live.provider_session_id.clone()),
                    question.clone(),
                    CancellationToken::new(),
                )
                .await;
            let answered = match reply {
                Ok(reply) => side_question_row(session_id, side_question_id, question, reply),
                Err(error) => Err(error.to_string()),
            };
            match answered {
                Ok(row) => {
                    controls
                        .deliver(session_id, InboundDelivery::SessionEvent { row })
                        .await;
                }
                Err(reason) => record_unheard_claude_failure(
                    DriverDiagnosticKind::ProcessReportFailed,
                    session_id,
                    "the side question",
                    &std::io::Error::other(reason),
                ),
            }
        });
    }

    /// Starts Claude Code's own review of `target` with its bundled `code-review` skill as the
    /// session's own run, between the `reviewStarted` and `reviewFinished` notices: a turn on the
    /// session's process for the working tree or the branch, and for the staged set a one-turn
    /// process in a worktree holding only the staged changes, which a stop ends. Returns once it
    /// has started; fails `ReviewSkillAbsent` when the build lists no such skill, and as the run's
    /// start fails.
    pub(crate) async fn start_review(
        self: &Arc<Self>,
        live: &Arc<LiveClaudeSession>,
        target: SessionReviewTarget,
    ) -> Result<(), DriverError> {
        let session_id = live.session_id;
        let has_skill = self
            .run_start
            .handshakes
            .held_handshake_for(session_id, &live.provider_session_id)
            .is_some_and(|held| {
                held.declaration
                    .skills
                    .iter()
                    .any(|skill| skill == CLAUDE_REVIEW_SKILL_NAME)
            });
        if !has_skill {
            return Err(claude_session_unavailable(
                ClaudeSessionUnavailableReason::ReviewSkillAbsent,
                session_id,
                None,
            )
            .into());
        }
        if target == SessionReviewTarget::Staged {
            return self.start_staged_review(live).await;
        }
        // Held before the turn starts, so a review whose turn ends at once still finishes.
        self.lock()
            .reviews
            .insert(session_id, ClaudeReviewProgress::default());
        let opening = ClaudeDaemonTurnOpening::Text {
            text: OutboundText {
                text: compose_review_command(target),
                origin: OutboundTextOrigin::DriverCommand,
            },
            message_id: mint_uuid_v7().to_string(),
            attachment_blocks: Vec::new(),
        };
        if let Err(error) = self.run_start.start_daemon_turn(session_id, opening).await {
            self.lock().reviews.remove(&session_id);
            return Err(error);
        }
        self.post_notice(
            session_id,
            SessionNotice::ReviewStarted { session_id, target },
        )
        .await;
        // The turn may have ended while the start notice went; its finish waited for it.
        let has_ended = {
            let mut tables = self.lock();
            match tables.reviews.get_mut(&session_id) {
                Some(review) if review.has_ended => {
                    tables.reviews.remove(&session_id);
                    true
                }
                Some(review) => {
                    review.is_started_posted = true;
                    false
                }
                None => false,
            }
        };
        if has_ended {
            self.post_notice(session_id, SessionNotice::ReviewFinished { session_id })
                .await;
        }
        Ok(())
    }

    /// Follows the session's live command list: the listener gets the current list now and each
    /// new one the session's process declares, until the subscription drops.
    pub(crate) fn subscribe_provider_commands(
        &self,
        session_id: SessionId,
        listener: ProviderCommandsListener,
    ) -> ProviderCommandsSubscription {
        let follower = {
            let mut tables = self.lock();
            let follower = tables.next_follower;
            tables.next_follower += 1;
            tables
                .followers
                .entry(session_id)
                .or_default()
                .insert(follower, Arc::clone(&listener));
            follower
        };
        if let Some(current) = (self.read_commands)(session_id) {
            listener(current);
        }
        let tables = Arc::clone(&self.tables);
        ProviderCommandsSubscription::new(move || {
            let mut tables = tables.lock().unwrap_or_else(PoisonError::into_inner);
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
        if frame_kind.split('/').next() == Some("result") {
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
        Ok(effective_output_style(settings.response.as_deref()).as_deref() == Some(output_style))
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
                    advisor_model: Some(claude_advisor_setting(advisor_model)),
                    ..ClaudeFlagSettings::default()
                },
            })
            .await?;
        let settings = live
            .channel
            .send_control_request(ClaudeControlRequest::GetSettings {})
            .await?;
        let attached = read_claude_attached_advisor(settings.response.as_deref());
        {
            let mut held = lock(&live.settings);
            held.advisor_model = advisor_model.map(str::to_owned);
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

    // Runs one unkept turn on `legs` with the session's rules, the words given as the daemon's.
    async fn run_one_turn(
        &self,
        live: &LiveClaudeSession,
        legs: &ClaudeSpawnBoundLegs,
        resume_handle: Option<String>,
        text: String,
        stop: CancellationToken,
    ) -> Result<ClaudeOneTurnReply, ClaudeLaunchError> {
        let session_rules = read_claude_session_rules(&self.session_rules, live.session_id)
            .await
            .map_err(|error| ClaudeLaunchError::Build(DriverError::Internal(error)))?;
        let in_process_servers = self.in_process_tool_servers.port();
        self.starts
            .run_one_turn(ClaudeOneTurnRequest {
                spawn: ClaudeSessionSpawn {
                    legs,
                    provider_account_id: live.admitted_provider_account_id.clone(),
                    session_rules: &session_rules,
                    step_bound: None,
                    in_process_servers,
                    path_rules: PathRules::NATIVE,
                },
                resume_handle,
                text: OutboundText {
                    text,
                    origin: OutboundTextOrigin::DriverCommand,
                },
                stop,
            })
            .await
    }

    // Delivers in order with the session's rows: in place on its task, else through its queue,
    // else, with no process left to order it, straight to the run engine.
    async fn deliver(
        &self,
        session_id: SessionId,
        delivery: InboundDelivery<'static>,
    ) -> Option<InboundOutcome> {
        let engine = &*self.run_start.engine;
        if ClaudeDeliveryPlace::current().is_some() {
            return deliver_in_current_place(engine, delivery).await;
        }
        match self.run_start.streams.get(session_id) {
            Some(stream) => stream.arrivals().dispatch(delivery).await,
            None => engine.deliver(None, None, delivery).await,
        }
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

// The session's legs on its full model id, level, advisor and style now, in `working_directory`
// where one is given, for a one-turn process that runs the very model the session does.
/// The legs a one-turn process of `live`'s session starts on: its own, at the level, advisor and
/// style it runs with now, on the full id of the model it runs, in `working_directory` where one is
/// given.
pub(crate) fn one_turn_legs(
    live: &LiveClaudeSession,
    working_directory: Option<std::path::PathBuf>,
) -> ClaudeSpawnBoundLegs {
    let settings = lock(&live.settings).clone();
    let model = live
        .initialize
        .models
        .iter()
        .find(|offered| offered.value == settings.running_model)
        .and_then(|offered| offered.resolved_model.clone())
        .unwrap_or(settings.running_model);
    ClaudeSpawnBoundLegs {
        model,
        execution_posture: settings.execution_posture,
        advisor_model: settings.advisor_model,
        output_style: settings.output_style,
        working_directory: working_directory
            .unwrap_or_else(|| live.spawn_bound_legs.working_directory.clone()),
        ..live.spawn_bound_legs.clone()
    }
}

// The answered row of a side question, or why it has none: a refusal has no answer, and its
// reason names only the model, since a diagnostic never carries the model's own words.
fn side_question_row(
    session_id: SessionId,
    side_question_id: SideQuestionId,
    question: String,
    reply: ClaudeOneTurnReply,
) -> Result<SessionScopedRow, String> {
    if reply.refusal.is_some() {
        return Err("The side question was refused.".to_owned());
    }
    let question = FreeFormText::new(question).map_err(|error| error.to_string())?;
    let answer = FreeFormText::new(reply.text).map_err(|error| error.to_string())?;
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
        .models
        .iter()
        .find(|offered| offered.value == model || offered.resolved_model.as_deref() == Some(model))
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
        (None, _) | (Some(_), _) => None,
    }
}

// The output style a `get_settings` reply says is in effect.
fn effective_output_style(reply: Option<&RawValue>) -> Option<String> {
    serde_json::from_str::<SettingsReply>(reply?.get())
        .ok()?
        .effective?
        .output_style
}

// The review command for `target`: with no words the skill reads the branch's commits ahead of
// its upstream and every uncommitted change; the working tree alone is named in words.
fn compose_review_command(target: SessionReviewTarget) -> String {
    match target {
        SessionReviewTarget::Branch => format!("/{CLAUDE_REVIEW_SKILL_NAME}"),
        SessionReviewTarget::WorkingTree | SessionReviewTarget::Staged => {
            format!("/{CLAUDE_REVIEW_SKILL_NAME} the uncommitted changes in the working tree")
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
