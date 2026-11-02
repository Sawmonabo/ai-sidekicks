//! How a goal on Claude Code ends, read from what Claude Code writes: the lead's `Goal set:`,
//! `Goal cleared` and `No goal set` lines, the goal check's own user frames, the `goal_status`
//! records of the conversation file and the lead `result` that ends a turn. Each is classified
//! against the session's goal memory into the goal row or the notice it draws, or nothing; a shape
//! no row covers is logged by its frame's kind and dropped.

use std::collections::HashMap;
use std::error::Error;
use std::io;
use std::path::PathBuf;
use std::sync::Mutex;

use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::session::controls::events::SessionNotice;
use sidekicks_contracts::session::goal::{
    SessionGoal, SessionGoalClearedPayload, SessionGoalStatus, SessionGoalUpdatedPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;

use super::records::{GoalStatusRecord, read_goal_status_tail};
use crate::driver::claude::delivery::system::{ClaudeProviderWords, read_provider_words};
use crate::driver::claude::session::conversation_file::conversation_file_of;
use crate::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;

// The lead's line once `/goal <condition>` set or replaced the goal.
const GOAL_SET_PREFIX: &str = "Goal set: ";

// The lead's line once the goal was cleared: by `/goal clear` (`Goal cleared: <condition>`) or
// after an unrecoverable error (`Goal cleared after an unrecoverable error`).
const GOAL_CLEARED_PREFIX: &str = "Goal cleared";

// The lead's line for `/goal` or `/goal clear` with no goal set.
const NO_GOAL_SET_PREFIX: &str = "No goal set";

/// The kind a `goal_status` record of the conversation file is named by, in a log line or on its
/// delivery.
pub(crate) const GOAL_STATUS_RECORD_KIND: &str = "attachment/goal_status";

// The user frame Claude Code makes up for an unmet check, `Stop hook feedback: [<c>]: <reason>`.
const STOP_HOOK_FEEDBACK_PREFIX: &str = "Stop hook feedback:";

/// What one frame, record or turn end draws for the session's goal.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum GoalEnding {
    /// `session.goal.updated`: a goal set or replaced, met, or found impossible.
    Updated(SessionGoalUpdatedPayload),
    /// `session.goal.cleared`.
    Cleared(SessionGoalClearedPayload),
    /// The `goalNotMet` notice: the turn ended at Claude Code's cap on unmet checks.
    NoticeNotMet(SessionNotice),
    /// The `goalCheckUnfinished` notice: a check ran past its limit and wrote no outcome.
    NoticeCheckUnfinished(SessionNotice),
    /// Nothing to draw.
    Nothing,
}

/// One thing Claude Code wrote that can end, set or keep a goal.
#[derive(Clone, Copy, Debug)]
pub(crate) enum GoalEndingInput<'read> {
    /// The text of a lead `assistant` frame.
    LeadText(&'read str),
    /// The text of a helper's `assistant` frame.
    HelperText(&'read str),
    /// The text of a `user` frame Claude Code made up itself.
    SyntheticUser(&'read str),
    /// A meta `user` frame: the deferred check's check-in.
    MetaUser,
    /// A `goal_status` record of the conversation file.
    Record(&'read GoalStatusRecord),
    /// The lead `result` that ends a turn.
    Result(GoalTurnEnd),
}

impl GoalEndingInput<'_> {
    // The kind of frame the input came on, which a log line names in place of its text.
    const fn frame_kind(&self) -> &'static str {
        match self {
            Self::LeadText(_) | Self::HelperText(_) => "assistant",
            Self::SyntheticUser(_) | Self::MetaUser => "user",
            Self::Record(_) => GOAL_STATUS_RECORD_KIND,
            Self::Result(_) => "result",
        }
    }
}

/// The facts about a turn's end a goal row reads, beside its lead `result`.
#[derive(Clone, Copy, Debug, Default)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "each fact about the turn is its own, read alone"
)]
pub(crate) struct GoalTurnEnd {
    /// The turn stopped at the session's step bound (`error_max_turns`), that bound's own row.
    pub(crate) is_step_bound: bool,
    /// An interrupt stopped the turn.
    pub(crate) is_interrupted: bool,
    /// Claude Code sent its `stop-hook-block-cap` notification this turn.
    pub(crate) is_check_capped: bool,
    /// The `result` carries no text.
    pub(crate) is_text_empty: bool,
    /// The conversation file held a `goal_status` record written this turn.
    pub(crate) has_record: bool,
    /// A helper or a background task of the session still runs, which defers the check.
    pub(crate) has_live_work: bool,
}

/// One session's goal as the classifier keeps it: whose it is and the condition of the goal that
/// is active, `None` while none is.
#[derive(Debug)]
pub(crate) struct ClaudeSessionGoal {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The session's lead, whose goal it is.
    pub(crate) agent_id: AgentId,
    /// The active goal's condition.
    pub(crate) active_condition: Option<String>,
}

impl ClaudeSessionGoal {
    // The goal set or replaced with `condition`; the condition already active draws nothing.
    fn set(&mut self, condition: &str, input: &GoalEndingInput<'_>) -> GoalEnding {
        if self.active_condition.as_deref() == Some(condition) {
            return GoalEnding::Nothing;
        }
        let Ok(text) = FreeFormText::new(condition.to_owned()) else {
            self.report_unlisted(input);
            return GoalEnding::Nothing;
        };
        self.active_condition = Some(condition.to_owned());
        self.updated(text, SessionGoalStatus::Active, None)
    }

    // The active goal ended at `status`, which clears it in Claude Code; none active draws nothing.
    fn end(
        &mut self,
        condition: Option<&str>,
        status: SessionGoalStatus,
        reason: Option<&str>,
    ) -> GoalEnding {
        let Some(active) = self.active_condition.take() else {
            return GoalEnding::Nothing;
        };
        let Ok(text) = FreeFormText::new(condition.unwrap_or(&active).to_owned()) else {
            tracing::debug!(
                session_id = %self.session_id,
                "a Claude Code goal outcome naming no condition a goal row can carry was dropped"
            );
            return GoalEnding::Nothing;
        };
        let reason = (status == SessionGoalStatus::Impossible).then(|| {
            reason
                .and_then(read_provider_words)
                .unwrap_or_else(|| UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone())
        });
        self.updated(text, status, reason)
    }

    fn updated(
        &self,
        text: FreeFormText<{ usize::MAX }>,
        status: SessionGoalStatus,
        reason: Option<ClaudeProviderWords>,
    ) -> GoalEnding {
        GoalEnding::Updated(SessionGoalUpdatedPayload {
            session_id: self.session_id,
            agent_id: self.agent_id,
            goal: SessionGoal { text },
            status,
            reason,
        })
    }

    fn cleared(&mut self) -> GoalEnding {
        self.active_condition = None;
        GoalEnding::Cleared(SessionGoalClearedPayload {
            session_id: self.session_id,
            agent_id: self.agent_id,
        })
    }

    fn report_unlisted(&self, input: &GoalEndingInput<'_>) {
        tracing::debug!(
            session_id = %self.session_id,
            frame_kind = input.frame_kind(),
            "a Claude Code goal shape no goal row covers was dropped"
        );
    }
}

/// Classifies one thing Claude Code wrote against `session`'s goal into the row it draws, keeping
/// the goal it leaves: a set or a sentinel naming a condition not active draws the goal active, the
/// same condition nothing; a clear draws the clear; a met check draws it complete and a failed one
/// impossible, both clearing it; an unmet check and the check's own user frames keep it active; a
/// turn ended at the check cap with an empty `result` draws `goalNotMet`, and one ended with the
/// goal active, nothing deferring the check, no record, no interrupt and no cap draws
/// `goalCheckUnfinished`. The step bound's end, a helper's goal line and an outcome with no goal
/// active draw nothing.
pub(crate) fn classify_goal_ending(
    session: &mut ClaudeSessionGoal,
    input: &GoalEndingInput<'_>,
) -> GoalEnding {
    match input {
        GoalEndingInput::LeadText(text) => {
            if let Some(condition) = text.strip_prefix(GOAL_SET_PREFIX) {
                session.set(condition, input)
            } else if text.starts_with(GOAL_CLEARED_PREFIX) {
                session.cleared()
            } else if text.starts_with(NO_GOAL_SET_PREFIX) {
                if session.active_condition.is_some() {
                    session.cleared()
                } else {
                    GoalEnding::Nothing
                }
            } else {
                GoalEnding::Nothing
            }
        }
        GoalEndingInput::HelperText(text) => {
            if is_goal_line(text) {
                tracing::debug!(
                    session_id = %session.session_id,
                    frame_kind = input.frame_kind(),
                    "a helper's goal line draws no goal row"
                );
            }
            GoalEnding::Nothing
        }
        GoalEndingInput::SyntheticUser(text) => {
            if !text.starts_with(STOP_HOOK_FEEDBACK_PREFIX) {
                session.report_unlisted(input);
            }
            GoalEnding::Nothing
        }
        GoalEndingInput::MetaUser => GoalEnding::Nothing,
        GoalEndingInput::Record(record) => classify_record(session, record, input),
        GoalEndingInput::Result(end) => classify_turn_end(session, *end, input),
    }
}

fn classify_record(
    session: &mut ClaudeSessionGoal,
    record: &GoalStatusRecord,
    input: &GoalEndingInput<'_>,
) -> GoalEnding {
    let condition = record.condition.as_deref();
    match (record.met, record.failed, record.sentinel) {
        // A set, or a compaction's rewrite of the goal.
        (false, false, true) => {
            if let Some(condition) = condition {
                session.set(condition, input)
            } else {
                session.report_unlisted(input);
                GoalEnding::Nothing
            }
        }
        // A clear, which the stream's `Goal cleared` line has usually drawn already.
        (true, false, true) => {
            if session.active_condition.is_some() {
                session.cleared()
            } else {
                GoalEnding::Nothing
            }
        }
        (true, false, false) => session.end(condition, SessionGoalStatus::Complete, None),
        (false, true, false) => session.end(
            condition,
            SessionGoalStatus::Impossible,
            record.reason.as_deref(),
        ),
        // An unmet check: the goal stays active.
        (false, false, false) => GoalEnding::Nothing,
        (true, true, _) | (false, true, true) => {
            session.report_unlisted(input);
            GoalEnding::Nothing
        }
    }
}

fn classify_turn_end(
    session: &ClaudeSessionGoal,
    end: GoalTurnEnd,
    input: &GoalEndingInput<'_>,
) -> GoalEnding {
    if session.active_condition.is_none() || end.is_step_bound || end.is_interrupted {
        return GoalEnding::Nothing;
    }
    let (session_id, agent_id) = (session.session_id, session.agent_id);
    if end.is_check_capped {
        if end.is_text_empty {
            return GoalEnding::NoticeNotMet(SessionNotice::GoalNotMet {
                session_id,
                agent_id,
            });
        }
        session.report_unlisted(input);
        return GoalEnding::Nothing;
    }
    // A check with work still running is deferred, and one that finished wrote its record.
    if end.has_record || end.has_live_work {
        return GoalEnding::Nothing;
    }
    GoalEnding::NoticeCheckUnfinished(SessionNotice::GoalCheckUnfinished {
        session_id,
        agent_id,
    })
}

// Whether `text` reads as one of Claude Code's goal lines.
fn is_goal_line(text: &str) -> bool {
    [GOAL_SET_PREFIX, GOAL_CLEARED_PREFIX, NO_GOAL_SET_PREFIX]
        .iter()
        .any(|prefix| text.starts_with(prefix))
}

/// Every session's goal while its process runs: the condition of each active goal, by session.
#[derive(Default)]
pub(crate) struct ClaudeGoalEndings {
    active_by_session: Mutex<HashMap<SessionId, String>>,
}

impl ClaudeGoalEndings {
    /// Takes the goal a session's process comes up with, as the daemon stored it: `None`, or a
    /// final status, leaves none active.
    #[expect(
        dead_code,
        reason = "the session bring-up that seeds the goal the daemon stored"
    )]
    pub(crate) fn seed(&self, session_id: SessionId, goal: Option<(String, SessionGoalStatus)>) {
        let mut active = lock(&self.active_by_session);
        match goal {
            Some((condition, status))
                if !matches!(
                    status,
                    SessionGoalStatus::Complete | SessionGoalStatus::Impossible
                ) =>
            {
                active.insert(session_id, condition);
            }
            Some(_) | None => {
                active.remove(&session_id);
            }
        }
    }

    /// Classifies `input` against the goal of `session_id`, whose lead is `agent_id`.
    pub(crate) fn classify(
        &self,
        session_id: SessionId,
        agent_id: AgentId,
        input: GoalEndingInput<'_>,
    ) -> GoalEnding {
        let mut active = lock(&self.active_by_session);
        let mut session = ClaudeSessionGoal {
            session_id,
            agent_id,
            active_condition: active.remove(&session_id),
        };
        let ending = classify_goal_ending(&mut session, &input);
        if let Some(condition) = session.active_condition {
            active.insert(session_id, condition);
        }
        ending
    }

    /// Reads the records `process`'s conversation file gained since its last read and classifies
    /// each in order; a file that cannot be found or read is logged and reads none.
    pub(crate) async fn read_file(
        &self,
        session_id: SessionId,
        process: &ClaudeProcessGoal,
    ) -> ClaudeGoalFileEndings {
        let agent_id = process.agent_id;
        let records = match read_new_records(&process.file).await {
            Ok(records) => records,
            Err(error) => {
                tracing::warn!(
                    %session_id,
                    error = &error as &(dyn Error + 'static),
                    "the goal checks' outcomes could not be read from Claude Code's conversation file"
                );
                Vec::new()
            }
        };
        ClaudeGoalFileEndings {
            has_record: !records.is_empty(),
            endings: records
                .iter()
                .map(|record| self.classify(session_id, agent_id, GoalEndingInput::Record(record)))
                .filter(|ending| *ending != GoalEnding::Nothing)
                .collect(),
        }
    }

    /// Forgets a session's goal once its process is gone; a later process's bring-up seeds it.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        lock(&self.active_by_session).remove(&session_id);
    }
}

/// What one read of the conversation file drew.
pub(crate) struct ClaudeGoalFileEndings {
    /// The rows its records draw, in order.
    pub(crate) endings: Vec<GoalEnding>,
    /// Whether it held any `goal_status` record.
    pub(crate) has_record: bool,
}

/// What one process's goal is read against: the session's lead, whose goal it is, and the
/// conversation file its outcomes are written to.
pub(crate) struct ClaudeProcessGoal {
    /// The session's lead.
    pub(crate) agent_id: AgentId,
    /// The conversation file, which only the session's task reads.
    pub(crate) file: Mutex<ClaudeGoalFile>,
}

/// One process's conversation file as the goal reads follow it: where Claude Code keeps it, once
/// found, and the offset the next read starts from.
#[derive(Debug)]
pub(crate) struct ClaudeGoalFile {
    spawn_environment: Vec<(String, String)>,
    provider_session_id: String,
    path: Option<PathBuf>,
    end: u64,
}

impl ClaudeGoalFile {
    /// The file of conversation `provider_session_id` in the Claude Code home `spawn_environment`
    /// names, followed from its length as the process comes up, so what an earlier process wrote
    /// is never read again; one not yet written is followed from its start once it appears. A
    /// home that cannot be listed is logged, and the file looked for again at the next read.
    pub(crate) async fn open(
        spawn_environment: &[(String, String)],
        provider_session_id: &str,
    ) -> Self {
        let mut file = Self {
            spawn_environment: spawn_environment.to_vec(),
            provider_session_id: provider_session_id.to_owned(),
            path: None,
            end: 0,
        };
        let found = match conversation_file_of(spawn_environment, provider_session_id).await {
            Ok(found) => found,
            Err(error) => {
                report_unlocated(provider_session_id, &error);
                None
            }
        };
        if let Some(path) = found {
            match tokio::fs::metadata(&path).await {
                Ok(metadata) => {
                    file.end = metadata.len();
                    file.path = Some(path);
                }
                Err(error) => report_unlocated(provider_session_id, &error),
            }
        }
        file
    }
}

fn report_unlocated(provider_session_id: &str, error: &io::Error) {
    tracing::warn!(
        provider_session_id,
        error = error as &(dyn Error + 'static),
        "Claude Code's conversation file could not be located for the goal reads"
    );
}

// The records `file` gained since its last read, its offset moved past them; the lock is never
// held across the read.
async fn read_new_records(file: &Mutex<ClaudeGoalFile>) -> io::Result<Vec<GoalStatusRecord>> {
    let (path, from, spawn_environment, provider_session_id) = {
        let file = lock(file);
        (
            file.path.clone(),
            file.end,
            file.spawn_environment.clone(),
            file.provider_session_id.clone(),
        )
    };
    let path = match path {
        Some(path) => path,
        None => match conversation_file_of(&spawn_environment, &provider_session_id).await? {
            Some(path) => path,
            None => return Ok(Vec::new()),
        },
    };
    let tail = read_goal_status_tail(&path, from).await?;
    let mut file = lock(file);
    file.path = Some(path);
    file.end = tail.end;
    Ok(tail.records)
}

#[cfg(test)]
mod tests;
