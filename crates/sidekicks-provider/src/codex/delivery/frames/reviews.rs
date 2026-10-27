//! The reviewer's frames: on a helper's thread on its child run, a turn-wide flag about its
//! `subagent.started` row; on the session's own thread on its turn's run, about the turn's start.
//! One no run owns is reported. A block goes to the approval service.

use serde_json::{Map, Value};
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::codex::delivery::children::ChildRunLookup;
use crate::codex::delivery::frames::{CodexFrameDelivery, report_unattributed};
use crate::codex::delivery::reviewer::{
    CodexReviewFlag, complete_codex_review, hold_guardian_warning, require_codex_review,
};
use crate::codex::delivery::rows::CodexRowRun;
use crate::codex::session::state::CodexSessionRecord;
use crate::codex::transport::diagnostics::{CodexDeliveryPort, CodexTransportDiagnostic};
use crate::port::reviewer_denial::ProviderReviewerDenial;
use crate::record_readers::read_non_empty_string;
use crate::run::delivery::{DeliveryBinding, InboundDelivery};

impl CodexFrameDelivery {
    pub(super) async fn deliver_reviewer_frame(
        &self,
        record: &mut CodexSessionRecord,
        method: &str,
        members: &Map<String, Value>,
    ) {
        let thread_id = read_non_empty_string(members, "threadId");
        let turn_id = read_non_empty_string(members, "turnId");
        let (run, about_event_id) = if thread_id == Some(record.thread_id.as_str()) {
            let turn_run = turn_id.and_then(|turn_id| self.turn_run_for(record, turn_id));
            if turn_run.is_none() && method != "guardianWarning" {
                report_unattributed(method, turn_id);
            }
            let about_event_id = turn_id
                .and_then(|turn_id| record.delivery.started_turn_by_turn_id.get(turn_id))
                .map(|started| started.event_id.clone());
            (turn_run.map(|turn_run| turn_run.row_run()), about_event_id)
        } else {
            // A thread that is neither the session's own nor a live helper's has no run to own
            // it; a helper whose start was refused has none either.
            match thread_id.map(|thread_id| record.child_run_on(thread_id)) {
                Some(ChildRunLookup::Started {
                    run,
                    start_row_event_id,
                }) => (Some(run), start_row_event_id),
                Some(ChildRunLookup::Unstarted) => return,
                Some(ChildRunLookup::NotAHelper) | None => {
                    report_unattributed(method, turn_id);
                    return;
                }
            }
        };
        self.deliver_review(record, method, members, run, about_event_id)
            .await;
    }

    async fn deliver_review(
        &self,
        record: &mut CodexSessionRecord,
        method: &str,
        members: &Map<String, Value>,
        run: Option<CodexRowRun>,
        about_event_id: Option<FreeFormText<EVENT_FIELD_MAX_LEN>>,
    ) {
        match method {
            "guardianWarning" => hold_guardian_warning(&mut record.delivery, members),
            "item/autoApprovalReview/completed" => {
                let completion = complete_codex_review(&mut record.delivery, members, run.as_ref());
                if let Some(flag) = completion.flag {
                    self.send_review_flag(record, flag).await;
                }
                if let Some(denial) = completion.denial {
                    self.hand_over_block(record, denial).await;
                }
            }
            _ => {
                if let Some((run, turn_id)) = run.zip(read_non_empty_string(members, "turnId")) {
                    let flag = require_codex_review(about_event_id, turn_id, run);
                    self.send_review_flag(record, flag).await;
                }
            }
        }
    }

    /// Writes a reviewer flag about the event it points at; one whose event was never written gets
    /// no flag, and that is reported.
    pub(in crate::codex::delivery) async fn send_review_flag(
        &self,
        record: &CodexSessionRecord,
        flag: CodexReviewFlag,
    ) {
        let Some(row) = flag.row() else {
            report_unattributed(flag.method, flag.turn_id.as_deref());
            return;
        };
        let delivery = InboundDelivery::UnstampedRow {
            binding: DeliveryBinding {
                binding_id: flag.run.binding_id.clone(),
                operation: None,
            },
            row,
        };
        self.send(record, delivery, flag.method).await;
    }

    // Hands a block to the approval service, reporting a record that could not be read or a
    // hand-off that failed. Until the service registers, a block stays Codex's own.
    async fn hand_over_block(
        &self,
        record: &CodexSessionRecord,
        denial: Result<ProviderReviewerDenial, serde_json::Error>,
    ) {
        let Some(port) = self.dependencies.reviewer_denials.port() else {
            return;
        };
        let result = match denial {
            Ok(denial) => port.take_denial(denial).await,
            Err(error) => Err(Box::new(error).into()),
        };
        if let Err(error) = result {
            CodexTransportDiagnostic::PortDeliveryFailed {
                provider_account_id: record.provider_account_id.clone(),
                port: CodexDeliveryPort::ReviewerDenial,
                session_id: Some(record.session_id),
                error,
            }
            .report();
        }
    }
}
