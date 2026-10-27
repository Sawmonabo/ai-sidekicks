//! A turn's items: each tool call's start and end, a command's end even after its turn ended or
//! the session moved off its conversation, the reply, reasoning and plan streamed as pieces, a
//! plan handed on whole, a command's live output, and the tool boundary each finished call of the
//! session's own turn is.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use sidekicks_contracts::command::CommandId;
use sidekicks_contracts::session::controls::events::{SessionNotice, SessionNoticePostedPayload};

use crate::provider::driver::codex::DESCRIPTOR;
use crate::provider::driver::codex::delivery::children::ChildRunLookup;
use crate::provider::driver::codex::delivery::frames::{
    CodexFrameDelivery, CodexFrameDispatch, CodexItemRun, CodexTakenMessage,
};
use crate::provider::driver::codex::delivery::memory::{CodexRunningCommand, CodexStreamedProse};
use crate::provider::driver::codex::delivery::patches::read_codex_patch_files;
use crate::provider::driver::codex::delivery::rows::{
    CODEX_COMMAND_ITEM_TYPE, CodexItemRow, CodexProseRowType, CodexRowRun,
    compose_codex_prose_piece, is_codex_tool_item, item_type, read_codex_frame_item,
    read_codex_item_completed_row, read_codex_item_prose, read_codex_tool_start_row,
};
use crate::provider::driver::codex::session::state::CodexSessionRecord;
use crate::provider::driver::codex::transport::diagnostics::{
    CodexDeliveryPort, CodexTransportDiagnostic,
};
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::provider::driver::run_control::RunToolBoundary;
use crate::provider::driver::streamed_text::StreamedTextCompletion;
use crate::provider::record_readers::{read_count, read_non_empty_string};
use crate::provider::run::delivery::InboundDelivery;

/// The item echoing a tool output a client starts a turn with in place of a message.
const CODEX_TOOL_OUTPUT_ITEM_TYPE: &str = "functionCallOutput";

/// The item of a message the person sent, which carries the id it was sent under.
const CODEX_USER_MESSAGE_ITEM_TYPE: &str = "userMessage";

impl CodexFrameDelivery {
    pub(super) async fn deliver_item_started(
        &self,
        record: &mut CodexSessionRecord,
        members: &Map<String, Value>,
    ) {
        let Some((item, item_id, thread_id)) = read_item_frame(members) else {
            return;
        };
        let Some(run) = self.item_run(record, members, "item/started") else {
            return;
        };
        let started_at_ms = read_count(members, "startedAtMs").unwrap_or_else(now_ms);
        let memory = &mut record.delivery;
        memory
            .item_started_at_ms_by_turn_id
            .entry(run.turn_id.clone())
            .or_default()
            .insert(item_id.clone(), started_at_ms);
        match item_type(&item) {
            Some(CODEX_COMMAND_ITEM_TYPE) => {
                memory.running_command_by_item_id.insert(
                    item_id.clone(),
                    CodexRunningCommand {
                        thread_id: thread_id.clone(),
                        row: run.row.clone(),
                        started_at_ms,
                    },
                );
            }
            Some("fileChange") => {
                let paths = read_codex_patch_files(&item)
                    .iter()
                    .map(|file| file.path().as_str().to_owned())
                    .collect();
                memory
                    .changed_paths_by_item_id
                    .insert(item_id.clone(), paths);
            }
            Some("agentMessage") => {
                memory.reply_started_turn_ids.insert(run.turn_id.clone());
                // A reply's start can already carry its first words, which no delta repeats.
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    let text = text.to_owned();
                    append_prose(
                        record,
                        &run,
                        &item_id,
                        CodexProseRowType::Message,
                        &text,
                        "item/started",
                    );
                }
            }
            _ => {}
        }
        if is_codex_spawn_call(&item) {
            record.note_spawn_call(&thread_id, &item_id, &run.row);
        }
        if is_codex_tool_item(&item) {
            record
                .delivery
                .tool_row_run_by_item_id
                .insert(item_id.clone(), run.row.clone());
            let row = read_codex_tool_start_row(&item, &run.row, "item/started");
            self.admit_row(record, row).await;
        }
    }

    pub(super) async fn deliver_item_completed(
        &self,
        record: &mut CodexSessionRecord,
        members: &Map<String, Value>,
        dispatch: &mut CodexFrameDispatch,
    ) {
        let Some((item, item_id, thread_id)) = read_item_frame(members) else {
            return;
        };
        let turn_id = read_non_empty_string(members, "turnId").map(str::to_owned);
        if item_type(&item) == Some(CODEX_USER_MESSAGE_ITEM_TYPE)
            && let Some((client_message_id, turn_id)) =
                read_non_empty_string(&item, "clientId").zip(turn_id.as_deref())
        {
            dispatch.taken_messages.push(CodexTakenMessage {
                client_message_id: client_message_id.to_owned(),
                turn_id: turn_id.to_owned(),
            });
        }
        let command = take_running_command(record, &thread_id, &item_id);
        let completed = match command {
            Some(command) => Some((command.row, Some(command.started_at_ms))),
            None => self.item_run(record, members, "item/completed").map(|run| {
                let started_at_ms = record
                    .delivery
                    .item_started_at_ms_by_turn_id
                    .get_mut(&run.turn_id)
                    .and_then(|started| started.remove(&item_id));
                (run.row, started_at_ms)
            }),
        };
        if let Some((row, started_at_ms)) = completed {
            let finished = FinishedItem {
                item: &item,
                item_id: &item_id,
                thread_id: &thread_id,
                turn_id: turn_id.as_deref(),
                completed_at_ms: read_count(members, "completedAtMs").unwrap_or_else(now_ms),
            };
            self.complete_item(record, finished, &row, started_at_ms)
                .await;
        }
        // A tool call of the session's own thread that ended inside its live turn is a step
        // boundary. A helper takes no direct input, a command ending after its turn has no turn to
        // join, and a turn a pause interrupts at this step takes no more messages.
        let Some(turn_id) = turn_id else {
            return;
        };
        let Some(run_id) = record.active_turn_run(&turn_id) else {
            return;
        };
        if thread_id != record.thread_id
            || record.pause_run_id_by_turn_id.contains_key(&turn_id)
            || !is_codex_tool_item(&item)
        {
            return;
        }
        self.dependencies.effects.on_tool_boundary(RunToolBoundary {
            session_id: record.session_id,
            run_id,
        });
        if let Err(error) = self.dependencies.engine.count_step(run_id).await {
            CodexTransportDiagnostic::PortDeliveryFailed {
                provider_account_id: record.provider_account_id.clone(),
                port: CodexDeliveryPort::StepCount,
                session_id: Some(record.session_id),
                error,
            }
            .report();
        }
    }

    // A finished item: its prose's last piece and, for a plan, the plan itself; a tool call's
    // result or failure; a review's end.
    async fn complete_item(
        &self,
        record: &mut CodexSessionRecord,
        finished: FinishedItem<'_>,
        run: &CodexRowRun,
        started_at_ms: Option<u64>,
    ) {
        let FinishedItem {
            item,
            item_id,
            thread_id,
            turn_id,
            completed_at_ms,
        } = finished;
        let prose = read_codex_item_prose(item);
        if let Some(prose) = &prose {
            record.delivery.streamed_prose_by_item_id.remove(item_id);
            let completion = record.delivery.streamed_text.complete(item_id, &prose.text);
            let (last_piece, is_whole) = match completion {
                StreamedTextCompletion::Completed { last_piece } => (last_piece, true),
                StreamedTextCompletion::Diverged { last_piece } => (last_piece, false),
            };
            if let Some(piece) = last_piece {
                let row = compose_codex_prose_piece(
                    run,
                    item_id,
                    prose.row_type,
                    piece,
                    "item/completed",
                );
                self.admit_row(record, row).await;
            }
            if !is_whole {
                CodexTransportDiagnostic::StreamedTextDiverged {
                    provider_account_id: record.provider_account_id.clone(),
                    thread_id: thread_id.to_owned(),
                    item_id: item_id.to_owned(),
                }
                .report();
            }
        }
        if item_type(item) == Some("plan")
            && let Some((prose, turn_id)) = prose.as_ref().zip(turn_id)
            && !prose.text.trim().is_empty()
        {
            self.dependencies
                .effects
                .plan_proposed(run, &prose.text, turn_id, item_id);
        }
        if is_codex_spawn_call(item) && item.get("status").and_then(Value::as_str) == Some("failed")
        {
            record.settle_spawn_call(thread_id, item_id);
        }
        record.delivery.tool_row_event_id_by_item_id.remove(item_id);
        record.delivery.tool_row_run_by_item_id.remove(item_id);
        record.delivery.changed_paths_by_item_id.remove(item_id);
        if item_type(item) == Some(CODEX_TOOL_OUTPUT_ITEM_TYPE) {
            report_tool_output_echo(record, item);
        }
        let row = read_codex_item_completed_row(
            item,
            run,
            "item/completed",
            started_at_ms,
            Some(completed_at_ms),
        );
        self.admit_row(record, row).await;
        if item_type(item) == Some("exitedReviewMode") {
            let notice = InboundDelivery::SessionNotice {
                session_id: record.session_id,
                notice: SessionNoticePostedPayload::Notice(SessionNotice::ReviewFinished {
                    session_id: record.session_id,
                }),
            };
            self.send(record, notice, "item/completed").await;
        }
    }

    // A streamed piece of a reply, its reasoning or a plan, which goes out within the piece
    // interval.
    pub(super) fn deliver_prose_delta(
        &self,
        record: &mut CodexSessionRecord,
        method: &str,
        members: &Map<String, Value>,
    ) {
        let (row_type, method) = match method {
            "item/agentMessage/delta" => (CodexProseRowType::Message, "item/agentMessage/delta"),
            "item/plan/delta" => (CodexProseRowType::Message, "item/plan/delta"),
            "item/reasoning/summaryTextDelta" => (
                CodexProseRowType::Thinking,
                "item/reasoning/summaryTextDelta",
            ),
            "item/reasoning/summaryPartAdded" => (
                CodexProseRowType::Thinking,
                "item/reasoning/summaryPartAdded",
            ),
            _ => (CodexProseRowType::Thinking, "item/reasoning/textDelta"),
        };
        // A new summary part is set off from the one before, as the finished reasoning joins them.
        let delta = if method == "item/reasoning/summaryPartAdded" {
            let is_later_part = read_count(members, "summaryIndex").is_some_and(|index| index > 0);
            Some(if is_later_part { "\n\n" } else { "" })
        } else {
            members.get("delta").and_then(Value::as_str)
        };
        let Some((item_id, delta)) = read_non_empty_string(members, "itemId").zip(delta) else {
            return;
        };
        let Some(run) = self.item_run(record, members, method) else {
            return;
        };
        append_prose(record, &run, item_id, row_type, delta, method);
    }

    /// Admits one streamed piece of the item `item_id` as its row.
    pub(in crate::provider::driver::codex::delivery) async fn admit_prose_piece(
        &self,
        record: &mut CodexSessionRecord,
        item_id: &str,
        piece: String,
    ) {
        let Some(prose) = record
            .delivery
            .streamed_prose_by_item_id
            .get(item_id)
            .cloned()
        else {
            return;
        };
        let row =
            compose_codex_prose_piece(&prose.run, item_id, prose.row_type, piece, prose.method);
        self.admit_row(record, row).await;
    }

    // A command's output as it prints, to the running-commands stream and never stored; the whole
    // output lands on the command's own end.
    pub(super) fn deliver_command_output(
        &self,
        record: &CodexSessionRecord,
        members: &Map<String, Value>,
    ) {
        let Some(publisher) = self.dependencies.command_output.port() else {
            return;
        };
        // An item id outside the command id's bounds names no row the stream could show it in.
        let command_id = read_non_empty_string(members, "itemId")
            .and_then(|item_id| CommandId::new(item_id.to_owned()));
        let data = members.get("delta").and_then(Value::as_str);
        if let Some((command_id, data)) = command_id.zip(data) {
            publisher.publish_output(record.session_id, command_id, data.to_owned());
        }
    }

    async fn admit_row(&self, record: &mut CodexSessionRecord, row: Option<CodexItemRow>) {
        let Some(row) = row else {
            return;
        };
        let released = record
            .delivery
            .reorder_buffer
            .admit(row, tokio::time::Instant::now());
        self.send_rows(record, released).await;
    }

    // The run an item frame's rows go on: a helper's child run once it started, else the run of
    // the session's own turn.
    fn item_run(
        &self,
        record: &CodexSessionRecord,
        members: &Map<String, Value>,
        method: &str,
    ) -> Option<CodexItemRun> {
        let thread_id = read_non_empty_string(members, "threadId");
        if let Some((thread_id, turn_id)) = thread_id.zip(read_non_empty_string(members, "turnId"))
            && thread_id != record.thread_id
        {
            match record.child_run_on(thread_id) {
                ChildRunLookup::Started { run, .. } => {
                    return Some(CodexItemRun {
                        turn_id: turn_id.to_owned(),
                        row: run,
                    });
                }
                ChildRunLookup::Unstarted => return None,
                ChildRunLookup::NotAHelper => {}
            }
        }
        self.row_run_for(record, members, method)
    }
}

/// An item's end with what its row needs.
struct FinishedItem<'frame> {
    item: &'frame Map<String, Value>,
    item_id: &'frame str,
    thread_id: &'frame str,
    turn_id: Option<&'frame str>,
    completed_at_ms: u64,
}

/// Whether an item is the tool call that starts a helper.
pub(crate) fn is_codex_spawn_call(item: &Map<String, Value>) -> bool {
    item_type(item) == Some("collabAgentToolCall")
        && item.get("tool").and_then(Value::as_str) == Some("spawnAgent")
}

// The item an item frame carries, its id and its thread.
fn read_item_frame(members: &Map<String, Value>) -> Option<(Map<String, Value>, String, String)> {
    let item = read_codex_frame_item(members)?;
    let item_id = read_non_empty_string(item, "id")?.to_owned();
    let thread_id = read_non_empty_string(members, "threadId")?.to_owned();
    Some((item.clone(), item_id, thread_id))
}

// The command an item's end closes, on the conversation it started in, even after its turn ended
// or the session moved off that conversation; it leaves the memory here.
fn take_running_command(
    record: &mut CodexSessionRecord,
    thread_id: &str,
    item_id: &str,
) -> Option<CodexRunningCommand> {
    let commands = &mut record.delivery.running_command_by_item_id;
    if commands.get(item_id)?.thread_id != thread_id {
        return None;
    }
    commands.remove(item_id)
}

// The echo of a tool output a client started a turn with, which the daemon never sends.
fn report_tool_output_echo(record: &CodexSessionRecord, item: &Map<String, Value>) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: record.provider_account_id.clone(),
        kind: DriverDiagnosticKind::UnmappedWireKind,
        raw_wire_type: Some("item/completed".to_owned()),
        disposition_reason: "the echo of a tool output a client started a turn with, which the \
                             daemon never sends; it draws no row"
            .to_owned(),
        details: Map::from_iter([
            (
                "sessionId".to_owned(),
                Value::from(record.session_id.to_string()),
            ),
            (
                "tool".to_owned(),
                read_non_empty_string(item, "name").map_or(Value::Null, Value::from),
            ),
        ]),
    });
}

// Now, in Unix milliseconds, for an item frame that names no time.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

// Keeps a prose delta of `item_id` toward its next streamed piece, with the run its rows go on.
fn append_prose(
    record: &mut CodexSessionRecord,
    run: &CodexItemRun,
    item_id: &str,
    row_type: CodexProseRowType,
    delta: &str,
    method: &'static str,
) {
    let memory = &mut record.delivery;
    memory
        .streamed_prose_by_item_id
        .entry(item_id.to_owned())
        .or_insert_with(|| CodexStreamedProse {
            run: run.row.clone(),
            row_type,
            method,
        });
    // The deadline it arms is read back by the session's timer through `next_deadline`.
    let _deadline =
        memory
            .streamed_text
            .append(item_id, &run.turn_id, delta, tokio::time::Instant::now());
}
