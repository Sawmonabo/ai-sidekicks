//! The questions Codex's agent asks without waiting for the answer: a finished reply that carries
//! `questions` with `delivery: "async"`. Codex sends the whole item at its start and again at its
//! end, so it is read from the end alone and recorded once, open on the card while its run keeps
//! running; the person's next message answers it.

use serde_json::{Map, Value};
use sidekicks_contracts::question::{QuestionKind, QuestionOption, QuestionPrompt};
use sidekicks_contracts::wire::text::NonEmptyText;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::delivery::frames::CodexFrameDelivery;
use crate::driver::codex::delivery::rows::CodexRowRun;
use crate::driver::codex::session::state::CodexSessionRecord;
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::port::question::ProviderQuestion;

/// The one `delivery` of a reply the agent does not wait on.
const CODEX_ASYNC_DELIVERY: &str = "async";

impl CodexFrameDelivery {
    /// Hands the questions the finished reply `item` of `run` asks without waiting to the card,
    /// under the item's id. A reply with no `delivery` asks nothing, and one whose `delivery` is
    /// not `async` is logged and asks nothing.
    pub(super) fn hand_async_questions(
        &self,
        record: &CodexSessionRecord,
        item: &Map<String, Value>,
        item_id: &str,
        run: &CodexRowRun,
    ) {
        match item.get("delivery") {
            None | Some(Value::Null) => return,
            Some(Value::String(delivery)) if delivery == CODEX_ASYNC_DELIVERY => {}
            Some(delivery) => {
                report_unread_delivery(record, item_id, delivery);
                return;
            }
        }
        let questions = read_async_questions(item);
        // An async reply with no question is a message the agent sent on, not a question.
        if questions.is_empty() {
            return;
        }
        self.dependencies.effects.question_asked(ProviderQuestion {
            session_id: run.session_id,
            run_id: run.run_id,
            request_id: item_id.to_owned(),
            questions,
            is_agent_waiting: false,
        });
    }
}

// The questions of an async reply, each a title and its option labels, in their order, a choice
// where it lists options and typed text where it lists none; one with no title is left out.
fn read_async_questions(item: &Map<String, Value>) -> Vec<QuestionPrompt> {
    item.get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .filter_map(|question| {
            let text = question
                .get("title")
                .and_then(Value::as_str)
                .and_then(|title| NonEmptyText::new(title.to_owned()))?;
            let listed_options = question.get("options").and_then(Value::as_array);
            let kind = if listed_options.is_some_and(|options| !options.is_empty()) {
                QuestionKind::Choice
            } else {
                QuestionKind::Text
            };
            let options = listed_options
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(|label| NonEmptyText::new(label.to_owned()))
                .map(|label| QuestionOption {
                    label,
                    description: None,
                    preview: None,
                })
                .collect();
            Some(QuestionPrompt {
                header: None,
                text,
                kind,
                heading: None,
                description: None,
                options,
                several_answers: true,
                secret: false,
                required: None,
                default: None,
                minimum: None,
                maximum: None,
                step: None,
                unit: None,
                placeholder: None,
            })
        })
        .collect()
}

// A reply whose `delivery` the driver does not read, which asks nothing.
fn report_unread_delivery(record: &CodexSessionRecord, item_id: &str, delivery: &Value) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: DESCRIPTOR.provider_id(),
        provider_account_id: Some(record.provider_account_id.clone()),
        kind: DriverDiagnosticKind::UnmappedWireKind,
        raw_wire_type: Some("item/completed".to_owned()),
        disposition_reason: "a reply's delivery the driver does not read; no question is recorded"
            .to_owned(),
        details: Map::from_iter([
            (
                "sessionId".to_owned(),
                Value::from(record.session_id.to_string()),
            ),
            ("itemId".to_owned(), Value::from(item_id)),
            (
                "delivery".to_owned(),
                delivery.as_str().map_or(Value::Null, Value::from),
            ),
        ]),
    });
}
