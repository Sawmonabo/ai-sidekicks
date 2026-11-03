//! The goal rows a session's stream draws: each goal line, goal-check frame, conversation-file
//! record and turn end is classified against the session's goal, and what it draws is delivered
//! as the goal row or the notice, about the session as a whole.

use serde_json::Value;
use sidekicks_contracts::session::controls::events::SessionNoticePostedPayload;

use super::{ClaudeDeliveryStream, ClaudeSessionStream};
use crate::driver::claude::event_normalizer::ClaudeWireFrameKind;
use crate::driver::claude::goals::endings::{
    GOAL_STATUS_RECORD_KIND, GoalEnding, GoalEndingInput, GoalTurnEnd,
};
use crate::run::delivery::{InboundDelivery, SessionScopedRow};
use crate::run::state_entry::{RunStateEntry, RunStateReport};

impl ClaudeDeliveryStream {
    /// Classifies `input`, read off a frame of `frame_kind`, against the session's goal and
    /// delivers what it draws.
    pub(super) async fn classify_goal(
        &self,
        session: &ClaudeSessionStream,
        input: GoalEndingInput<'_>,
        frame_kind: &str,
    ) {
        let ending = self.dependencies.goal_endings.classify(
            session.session_id,
            session.goal.agent_id,
            input,
        );
        self.deliver_goal_ending(session, ending, frame_kind).await;
    }

    /// Reads the goal records the conversation file gained and delivers what each draws, in
    /// order; answers whether it held any.
    pub(super) async fn read_goal_records(&self, session: &ClaudeSessionStream) -> bool {
        let read = self
            .dependencies
            .goal_endings
            .read_file(session.session_id, &session.goal)
            .await;
        for ending in read.endings {
            self.deliver_goal_ending(session, ending, GOAL_STATUS_RECORD_KIND)
                .await;
        }
        read.has_record
    }

    /// What a turn's end, composed as `change` from its lead `result` `frame` of `kind`, draws
    /// for the goal; `has_record` says the conversation file held a record this turn.
    pub(super) fn classify_goal_turn_end(
        &self,
        session: &ClaudeSessionStream,
        frame: &Value,
        kind: &ClaudeWireFrameKind,
        change: Option<&RunStateReport>,
        has_record: bool,
    ) -> GoalEnding {
        let is_step_bound = *kind == ClaudeWireFrameKind::ResultErrorMaxTurns;
        let has_child_run = self
            .dependencies
            .routes
            .has_child_run_on(session.session_id);
        let end = {
            let readings = session.lock();
            GoalTurnEnd {
                is_step_bound,
                is_interrupted: change.is_some_and(|change| {
                    matches!(change.entry, RunStateEntry::Interrupted { .. })
                }),
                is_check_capped: readings.is_goal_check_capped,
                is_text_empty: frame
                    .get("result")
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty),
                has_record,
                has_live_work: has_child_run
                    || readings.command_tasks.has_running_task()
                    || readings.command_tasks.listed_other_tasks() > 0,
            }
        };
        self.dependencies.goal_endings.classify(
            session.session_id,
            session.goal.agent_id,
            GoalEndingInput::Result(end),
        )
    }

    /// Delivers what one goal ending draws, read off a frame of `frame_kind`.
    pub(super) async fn deliver_goal_ending(
        &self,
        session: &ClaudeSessionStream,
        ending: GoalEnding,
        frame_kind: &str,
    ) {
        let delivery = match ending {
            GoalEnding::Updated(payload) => InboundDelivery::SessionEvent {
                row: SessionScopedRow::GoalUpdated(payload),
            },
            GoalEnding::Cleared(payload) => InboundDelivery::SessionEvent {
                row: SessionScopedRow::GoalCleared(payload),
            },
            GoalEnding::NoticeNotMet(notice) | GoalEnding::NoticeCheckUnfinished(notice) => {
                InboundDelivery::SessionNotice {
                    session_id: session.session_id,
                    notice: SessionNoticePostedPayload::Notice(notice),
                }
            }
            GoalEnding::Nothing => return,
        };
        self.send(session, delivery, Some(frame_kind)).await;
    }
}
