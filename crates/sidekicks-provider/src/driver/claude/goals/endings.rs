//! How a goal on Claude Code ends, read from what Claude Code writes: the lead's `Goal set:`,
//! `Goal cleared` and `No goal set` lines, the goal check's own user frames, the `goal_status`
//! records of the conversation file and the lead `result` that ends a turn. Each is classified
//! against the session's goal memory into the goal row or the notice it draws, or nothing; a shape
//! no row covers is logged by its frame's kind and dropped.

use std::collections::HashMap;
use std::error::Error;
use std::sync::Mutex;

use sidekicks_contracts::agent::definition::AgentId;
use sidekicks_contracts::session::controls::events::SessionNotice;
use sidekicks_contracts::session::goal::{
    SessionGoal, SessionGoalClearedPayload, SessionGoalStatus, SessionGoalUpdatedPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;

use super::file::{ClaudeProcessGoal, read_new_records};
use super::records::GoalStatusRecord;
use crate::driver::claude::delivery::system::{ClaudeProviderWords, read_provider_words};
use crate::driver::error_causes::UNSPECIFIED_PROVIDER_FAILURE_DETAIL;

// The lead's line once `/goal <condition>` set or replaced the goal.
const GOAL_SET_PREFIX: &str = "Goal set: ";

// The lead's line once the goal was cleared: by `/goal clear` (`Goal cleared: <condition>`) or
// after an unrecoverable error (`Goal cleared after an unrecoverable error`).
const GOAL_CLEARED_PREFIX: &str = "Goal cleared";

/// The lead's line for `/goal` or `/goal clear` with no goal set.
pub(crate) const NO_GOAL_SET_PREFIX: &str = "No goal set";

/// The line a bare `/goal` prints while a goal is active, `Goal active: <condition> (<checks>)`.
pub(crate) const GOAL_ACTIVE_PREFIX: &str = "Goal active: ";

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
    match (record.is_met, record.is_failed, record.is_sentinel) {
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

/// Whether `text` reads as one of Claude Code's goal lines.
pub(crate) fn is_goal_line(text: &str) -> bool {
    [
        GOAL_SET_PREFIX,
        GOAL_CLEARED_PREFIX,
        NO_GOAL_SET_PREFIX,
        GOAL_ACTIVE_PREFIX,
    ]
    .iter()
    .any(|prefix| text.starts_with(prefix))
}

/// Every session's goal while its process runs: the condition of each active goal, by session.
#[derive(Default)]
pub(crate) struct ClaudeGoalEndings {
    active_by_session: Mutex<HashMap<SessionId, String>>,
}

impl ClaudeGoalEndings {
    /// Takes the goal a session's process restored from its conversation file as it came up: the
    /// condition of the active goal, or `None`, which leaves none active.
    pub(crate) fn seed(&self, session_id: SessionId, restored_condition: Option<String>) {
        let mut active = lock(&self.active_by_session);
        match restored_condition {
            Some(condition) => {
                active.insert(session_id, condition);
            }
            None => {
                active.remove(&session_id);
            }
        }
    }

    /// The condition of the goal active on `session_id`, `None` while none is.
    pub(crate) fn active_condition(&self, session_id: SessionId) -> Option<String> {
        lock(&self.active_by_session).get(&session_id).cloned()
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
                    "the goal checks' outcomes could not be read from Claude Code's conversation \
                     file"
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

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use sidekicks_contracts::session::controls::events::SessionNotice;
    use sidekicks_contracts::session::goal::{
        SessionGoal, SessionGoalClearedPayload, SessionGoalStatus, SessionGoalUpdatedPayload,
    };
    use sidekicks_contracts::wire::text::FreeFormText;

    use super::{
        ClaudeSessionGoal, GoalEnding, GoalEndingInput, GoalTurnEnd, classify_goal_ending,
    };
    use crate::driver::claude::goals::records::GoalStatusRecord;
    use crate::driver::claude::goals::records::tests::record;
    use crate::driver::test_registry::{new_agent_id, new_session_id};

    // What Claude Code wrote, owned so a case can hold it.
    enum Written {
        Lead(&'static str),
        Helper(&'static str),
        Synthetic(&'static str),
        Meta,
        Record(GoalStatusRecord),
        End(GoalTurnEnd),
    }

    // The row a case expects drawn.
    enum Drawn {
        Nothing,
        Active(&'static str),
        Complete(&'static str),
        Impossible(&'static str, &'static str),
        Cleared,
        NotMet,
        CheckUnfinished,
    }

    fn updated(
        session: &ClaudeSessionGoal,
        condition: &str,
        status: SessionGoalStatus,
        reason: Option<&str>,
    ) -> GoalEnding {
        GoalEnding::Updated(SessionGoalUpdatedPayload {
            session_id: session.session_id,
            agent_id: session.agent_id,
            goal: SessionGoal {
                text: FreeFormText::new(condition.to_owned()).expect("a test condition fits"),
            },
            status,
            reason: reason.map(|reason| FreeFormText::new(reason.to_owned()).expect("it fits")),
        })
    }

    // One case per row of the goal table, each naming its row; the mutation each kills: `set_again`
    // the condition compare dropped (the same condition posts again); `replaced` a replaced goal
    // dropped; `sentinel_clear` the sentinel read dropped or read without `met` (a clear reads as
    // complete); `impossible` `failed` read as complete; `stop_hook_feedback`, `unmet` and
    // `check_in` a check frame or unmet record that clears the goal or reads as a message; `capped`
    // the cap mark dropped (the empty `result` posts no `goalNotMet`); `deferred` the liveness
    // check dropped (a deferred result reads as unfinished); `step_bound` and `interrupted` either
    // fact dropped (the turn reads as unfinished); `no_goal_set_*` the active check dropped either
    // way.
    #[rstest]
    #[case::set(None, Written::Lead("Goal set: c"), Drawn::Active("c"), Some("c"))]
    #[case::set_again(Some("c"), Written::Lead("Goal set: c"), Drawn::Nothing, Some("c"))]
    #[case::replaced(
        Some("c"),
        Written::Record(record(false, false, true, Some("d"))),
        Drawn::Active("d"),
        Some("d")
    )]
    #[case::sentinel_same(
        Some("d"),
        Written::Record(record(false, false, true, Some("d"))),
        Drawn::Nothing,
        Some("d")
    )]
    #[case::cleared_line(Some("d"), Written::Lead("Goal cleared: d"), Drawn::Cleared, None)]
    #[case::cleared_after_error(
        Some("d"),
        Written::Lead("Goal cleared after an unrecoverable error"),
        Drawn::Cleared,
        None
    )]
    #[case::sentinel_clear(
        Some("c"),
        Written::Record(record(true, false, true, Some("c"))),
        Drawn::Cleared,
        None
    )]
    #[case::sentinel_clear_already_recorded(
        None,
        Written::Record(record(true, false, true, Some("c"))),
        Drawn::Nothing,
        None
    )]
    #[case::no_goal_set_none(
        None,
        Written::Lead("No goal set. Usage: /goal <condition>"),
        Drawn::Nothing,
        None
    )]
    #[case::no_goal_set_active(Some("c"), Written::Lead("No goal set"), Drawn::Cleared, None)]
    #[case::complete(
        Some("c"),
        Written::Record(record(true, false, false, Some("c"))),
        Drawn::Complete("c"),
        None
    )]
    #[case::complete_already_recorded(
        None,
        Written::Record(record(true, false, false, Some("c"))),
        Drawn::Nothing,
        None
    )]
    #[case::impossible(
    Some("c"),
    Written::Record(GoalStatusRecord {
        reason: Some("it cannot be done".to_owned()),
        ..record(false, true, false, Some("c"))
    }),
    Drawn::Impossible("c", "it cannot be done"),
    None
)]
    #[case::unmet(
    Some("c"),
    Written::Record(GoalStatusRecord {
        reason: Some("not yet".to_owned()),
        ..record(false, false, false, Some("c"))
    }),
    Drawn::Nothing,
    Some("c")
)]
    #[case::stop_hook_feedback(
        Some("c"),
        Written::Synthetic("Stop hook feedback: [c]: not yet"),
        Drawn::Nothing,
        Some("c")
    )]
    #[case::check_in(Some("c"), Written::Meta, Drawn::Nothing, Some("c"))]
    #[case::capped(
    Some("c"),
    Written::End(GoalTurnEnd {
        is_check_capped: true,
        is_text_empty: true,
        has_record: true,
        ..GoalTurnEnd::default()
    }),
    Drawn::NotMet,
    Some("c")
)]
    #[case::deferred(
    Some("c"),
    Written::End(GoalTurnEnd { has_live_work: true, ..GoalTurnEnd::default() }),
    Drawn::Nothing,
    Some("c")
)]
    #[case::check_unfinished(
        Some("c"),
        Written::End(GoalTurnEnd::default()),
        Drawn::CheckUnfinished,
        Some("c")
    )]
    #[case::step_bound(
    Some("c"),
    Written::End(GoalTurnEnd { is_step_bound: true, ..GoalTurnEnd::default() }),
    Drawn::Nothing,
    Some("c")
)]
    #[case::interrupted(
    Some("c"),
    Written::End(GoalTurnEnd { is_interrupted: true, ..GoalTurnEnd::default() }),
    Drawn::Nothing,
    Some("c")
)]
    #[case::end_without_goal(None, Written::End(GoalTurnEnd::default()), Drawn::Nothing, None)]
    #[case::helper_goal_line(None, Written::Helper("Goal set: c"), Drawn::Nothing, None)]
    fn each_row_of_the_goal_table_draws_its_row_and_leaves_its_goal(
        #[case] active_before: Option<&str>,
        #[case] written: Written,
        #[case] drawn: Drawn,
        #[case] active_after: Option<&str>,
    ) {
        let mut session = ClaudeSessionGoal {
            session_id: new_session_id(),
            agent_id: new_agent_id(),
            active_condition: active_before.map(str::to_owned),
        };
        let input = match &written {
            Written::Lead(text) => GoalEndingInput::LeadText(text),
            Written::Helper(text) => GoalEndingInput::HelperText(text),
            Written::Synthetic(text) => GoalEndingInput::SyntheticUser(text),
            Written::Meta => GoalEndingInput::MetaUser,
            Written::Record(record) => GoalEndingInput::Record(record),
            Written::End(end) => GoalEndingInput::Result(*end),
        };
        let (session_id, agent_id) = (session.session_id, session.agent_id);
        let expected = match drawn {
            Drawn::Nothing => GoalEnding::Nothing,
            Drawn::Active(condition) => {
                updated(&session, condition, SessionGoalStatus::Active, None)
            }
            Drawn::Complete(condition) => {
                updated(&session, condition, SessionGoalStatus::Complete, None)
            }
            Drawn::Impossible(condition, reason) => updated(
                &session,
                condition,
                SessionGoalStatus::Impossible,
                Some(reason),
            ),
            Drawn::Cleared => GoalEnding::Cleared(SessionGoalClearedPayload {
                session_id,
                agent_id,
            }),
            Drawn::NotMet => GoalEnding::NoticeNotMet(SessionNotice::GoalNotMet {
                session_id,
                agent_id,
            }),
            Drawn::CheckUnfinished => {
                GoalEnding::NoticeCheckUnfinished(SessionNotice::GoalCheckUnfinished {
                    session_id,
                    agent_id,
                })
            }
        };

        let ending = classify_goal_ending(&mut session, &input);

        assert_eq!(ending, expected);
        assert_eq!(session.active_condition.as_deref(), active_after);
    }
}
