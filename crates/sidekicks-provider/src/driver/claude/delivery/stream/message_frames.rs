//! The lead's message frames on the session's task: an assistant message's rows, its calls' lines
//! and task-list changes, its step and its mid-turn context reading; a user message's rows, the
//! message another session sent and the echo of a message Claude Code took; and a streamed piece,
//! held for its interval while the tokens the turn received go to the working line.

use jiff::Timestamp;
use sidekicks_contracts::turn::TurnTasksUpdate;
use tokio::time::Instant;

use super::{ClaudeDeliveryStream, ClaudeFirstRequest, ClaudeSessionStream, report_engine_failure};
use crate::driver::claude::delivery::messages::{
    ClaudeMessageFrame, ClaudeMessageRow, ClaudeMessageRowKind, read_claude_assistant_rows,
    read_claude_user_rows, record_claude_traces,
};
use crate::driver::claude::delivery::peer_arrival::{publish_peer_arrival, read_peer_arrival};
use crate::driver::claude::delivery::run_readings::{ClaudeMessageKey, ClaudeRowDelivery};
use crate::driver::claude::delivery::streamed_blocks::ClaudeStreamedRun;
use crate::driver::claude::delivery::turn_readings::is_claude_message_start;
use crate::driver::claude::goals::endings::{GoalEndingInput, is_goal_line};
use crate::driver::claude::run::routes::ClaudeBoundRun;
use crate::driver::claude::session::transport::declarations::ClaudeMessageUsageObservation;
use crate::port::tool_traces::is_recording_tool_traces;
use crate::run::delivery::LateAppendableRow;

impl ClaudeDeliveryStream {
    // An assistant message's rows, its calls' lines and task-list changes, its step, and the
    // mid-turn context reading its `usage` gives.
    pub(super) async fn assistant(
        &self,
        session: &ClaudeSessionStream,
        lead: &ClaudeBoundRun,
        frame: &mut ClaudeMessageFrame,
        usage: Option<&ClaudeMessageUsageObservation>,
    ) {
        self.dependencies
            .dialogs
            .observe_assistant_error(lead.run_id, frame.error())
            .await;
        let provider_account_id = session.provider_account_id();
        let (pieces, rows, counts_step, tasks) = {
            let mut readings = session.lock();
            readings.has_turn_message = true;
            readings.command_tasks.observe_calls(frame);
            let tasks = readings.turn_readings.observe_calls(frame);
            // As Claude Code reads a turn, its last refused message is the turn's refusal.
            if let Some(refusal) = frame.refusal() {
                readings.refusal = Some(refusal);
            }
            let mut rows = read_claude_assistant_rows(
                frame,
                session.session_id,
                lead,
                &mut readings.open_tool_calls,
                &session.tool_call_arguments,
                Timestamp::now(),
            );
            // A goal line draws the goal row alone, never a message in the agent's own words.
            if frame.text().is_some_and(is_goal_line) {
                rows.retain(|row| !is_message(row));
            }
            // A step is one message carrying a tool call, the unit Claude Code's own bound counts.
            let counts_step = rows.iter().any(is_tool_call)
                && frame.provider_message_id().is_some_and(|message_id| {
                    readings.counted_step_messages.insert(message_id.to_owned())
                });
            let (pieces, unstreamed) =
                readings
                    .streamed_blocks
                    .finish(frame, rows, &provider_account_id);
            let key = frame
                .uuid()
                .map(|uuid| ClaudeMessageKey::Uuid(uuid.to_owned()));
            let rows = unstreamed
                .into_iter()
                .map(|row| ClaudeRowDelivery::of_message(&lead.binding_id, row, key.clone()))
                .collect::<Vec<_>>();
            (pieces, rows, counts_step, tasks)
        };
        session.tool_call_arguments.spill_past_bounds().await;
        if let Some(tasks) = tasks {
            self.publish_turn_tasks(session, tasks);
        }
        self.send_pieces(session, &lead.binding_id, pieces).await;
        if let Some(text) = frame.text() {
            self.classify_goal(session, GoalEndingInput::LeadText(text), "assistant")
                .await;
        }
        self.admit_rows(session, rows, "assistant").await;
        if counts_step && let Err(error) = self.dependencies.engine.count_step(lead.run_id).await {
            report_engine_failure(session, "a step", &*error);
        }
        if let Some(usage) = usage
            && let Some(row) =
                self.dependencies
                    .context
                    .read_mid_turn(session.session_id, lead.run_id, usage)
        {
            self.send_row(session, lead, row, "assistant").await;
        }
    }

    pub(super) async fn user(
        &self,
        session: &ClaudeSessionStream,
        lead: &ClaudeBoundRun,
        frame: &ClaudeMessageFrame,
    ) {
        let is_tracing = is_recording_tool_traces(&self.dependencies.tool_traces);
        let (rows, tasks, stand_ins, arrival, traces) = {
            let mut guard = session.lock();
            let readings = &mut *guard;
            let is_turn_start = !readings.has_turn_message;
            let arrival =
                read_peer_arrival(frame, session.session_id, Some(lead.run_id), is_turn_start);
            if let Some(arrival) = &arrival {
                readings.turn_senders.observe(arrival);
            }
            // Whatever the frame, a message after it joins the turn it started or joined.
            readings.has_turn_message = true;
            let reading = read_claude_user_rows(
                frame,
                session.session_id,
                &mut readings.open_tool_calls,
                &readings.tool_server_tasks,
                Timestamp::now(),
                is_tracing,
            );
            readings.failed_call_words.extend(reading.failed_results);
            let tasks = readings.turn_readings.observe_results(frame);
            let key = frame
                .uuid()
                .map(|uuid| ClaudeMessageKey::Uuid(uuid.to_owned()));
            let rows = reading
                .rows
                .into_iter()
                .map(|row| ClaudeRowDelivery::of_message(&lead.binding_id, row, key.clone()))
                .collect::<Vec<_>>();
            (rows, tasks, reading.held_stand_ins, arrival, reading.traces)
        };
        if let Some(tasks) = tasks {
            self.publish_turn_tasks(session, tasks);
        }
        // Claude Code echoes each message it took off its input with the uuid it was sent under.
        if frame.is_taken_echo()
            && let Some(uuid) = frame.uuid()
        {
            self.report_taken(session, uuid);
        }
        // The goal check's own frames carry no row and are never the person's message; an echo of
        // a message the daemon sent is no frame of Claude Code's own.
        if !frame.is_taken_echo() {
            if frame.is_meta() {
                self.classify_goal(session, GoalEndingInput::MetaUser, "user")
                    .await;
            } else if frame.is_synthetic() {
                let text = frame.text().unwrap_or_default();
                self.classify_goal(session, GoalEndingInput::SyntheticUser(text), "user")
                    .await;
            }
        }
        publish_peer_arrival(&self.dependencies.session_message_readings, arrival);
        self.admit_rows(session, rows, "user").await;
        record_claude_traces(&self.dependencies.tool_traces, traces).await;
        self.send_backgrounded(session, stand_ins).await;
    }

    // A streamed piece waits for its interval, which the session's timer sends; the tokens the
    // turn received go to the working line at once.
    pub(super) fn stream_event(
        &self,
        session: &ClaudeSessionStream,
        lead: &ClaudeBoundRun,
        text: &str,
    ) {
        let run = ClaudeStreamedRun {
            session_id: session.session_id,
            run_id: lead.run_id,
        };
        // Only a reply opened after an account move is the moved account's first request.
        if session.is_watching_first_request() && is_claude_message_start(text) {
            session.settle_first_request(ClaudeFirstRequest::Answered);
        }
        let provider_account_id = session.provider_account_id();
        let usage = {
            let mut readings = session.lock();
            readings
                .streamed_blocks
                .observe(text, run, &provider_account_id, Instant::now());
            readings.turn_readings.observe_stream_event(text)
        };
        if let (Some(usage), Some(publisher)) = (usage, self.dependencies.turn_readings.port()) {
            publisher.publish_turn_usage(session.session_id, usage);
        }
    }

    // Sends the turn's whole task list to the working line, once its readings are registered.
    pub(super) fn publish_turn_tasks(&self, session: &ClaudeSessionStream, tasks: TurnTasksUpdate) {
        if let Some(publisher) = self.dependencies.turn_readings.port() {
            publisher.publish_turn_tasks(session.session_id, tasks);
        }
    }
}

fn is_message(row: &ClaudeMessageRow) -> bool {
    matches!(
        row.row,
        ClaudeMessageRowKind::Session {
            row: LateAppendableRow::AgentMessageSent(_),
            ..
        }
    )
}

fn is_tool_call(row: &ClaudeMessageRow) -> bool {
    matches!(
        row.row,
        ClaudeMessageRowKind::Session {
            row: LateAppendableRow::AgentToolCallInvoked(_),
            ..
        }
    )
}
