//! The two choices Claude Code holds a run on and asks the daemon about through
//! `request_user_dialog`: retry a refused turn on a fallback model or edit it, and switch off Fable
//! or spend usage credits. Each is shown as its requested row and the run waits for input; the
//! person's answer goes back as the dialog's answer, and a choice the driver or Claude Code settles
//! without the person is recorded as its settlement row and the run's move.

use std::collections::{HashMap, HashSet};
use std::io;
use std::sync::{Mutex, MutexGuard};

use futures::future::BoxFuture;
use serde::Deserialize;
use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::event::version::EVENT_FIELD_MAX_LEN;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::provider::driver::methods::PROVIDER_WIRE_HANDLE_MAX_LEN;
use sidekicks_contracts::run::control::RunFailureCategory;
use sidekicks_contracts::run::failure_cause::{RunFailureCause, RunRefusedOrigin};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::provider_choice::{
    AgentRunRefusalChoiceRequestedPayload, AgentRunRefusalChoiceResolvedPayload,
    AgentRunUsageCreditsChoiceRequestedPayload, AgentRunUsageCreditsChoiceResolvedPayload,
    RunRefusalChoice, RunRefusalChoiceCanceled, RunRefusalChoiceSettlement, RunUsageCreditsChoice,
    RunUsageCreditsChoiceSettlement, RunUsageCreditsChoiceUnanswered,
};
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::BoundedInt;
use sidekicks_contracts::wire::text::FreeFormText;

use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::claude::hooks::callbacks::answer_claude_request;
use crate::provider::driver::claude::hooks::registration::ClaudeDialogKind;
use crate::provider::driver::claude::run::routes::ClaudeBoundRun;
use crate::provider::driver::claude::session::errors::ClaudeSessionError;
use crate::provider::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::provider::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::provider::driver::claude::session::transport::declarations::ClaudeOfferedModel;
use crate::provider::driver::claude::session::transport::inbound::ClaudeUserDialog;
use crate::provider::driver::claude::session::transport::user_message::{
    ClaudeWriteAttempt, ClaudeWriteDelivery,
};
use crate::provider::driver::contract::{DriverError, bound_failure_detail};
use crate::provider::driver::error_causes::{
    RequestUnanswered, UNSPECIFIED_PROVIDER_FAILURE_DETAIL, provider_failure_refusal,
};
use crate::provider::driver::run_control::{
    AnswerProviderChoiceParams, AnswerProviderChoiceResult, ProviderChoiceAnswer,
};
use crate::provider::lenient_json::{Lenient, LenientList, lenient_object, read_lenient};
use crate::session::run::inbound::rows::UnstampedRow;
use crate::session::run::inbound::{DeliveryBinding, InboundDelivery, InboundOutcome};
use crate::session::run::state_change::{RunStateChange, RunStateEntry};

// The models a switch off Fable moves to, in the order Claude Code tries them.
const CLAUDE_SWITCH_MODEL_FAMILIES: [&str; 3] = ["opus", "sonnet", "haiku"];

// The id prefix of the model the usage-credits choice is about.
const CLAUDE_FABLE_MODEL_PREFIX: &str = "claude-fable-";

// The error Claude Code ends a turn with when a message settled the usage-credits choice.
const CLAUDE_CONSENT_UNANSWERED_ERROR: &str = "consent_unanswered";

type WireHandle = FreeFormText<PROVIDER_WIRE_HANDLE_MAX_LEN>;

/// What the dialogs deliver through and report a run the daemon ended to.
#[cfg_attr(test, mockall::automock)]
pub(crate) trait ClaudeDialogPorts: Send + Sync {
    /// Hands one delivery to the run engine at once, before the returned future is first polled,
    /// and answers its outcome, `None` once a refusal is logged.
    fn deliver(&self, delivery: InboundDelivery<'static>) -> BoxFuture<'_, Option<InboundOutcome>>;

    /// The ids of the events the open turn's messages with these wire uuids were written as.
    fn event_ids_for_messages(
        &self,
        session_id: SessionId,
        message_uuids: Vec<String>,
    ) -> BoxFuture<'_, Vec<String>>;

    /// Marks the run's end as the daemon's, so the turn end Claude Code then sends is no second
    /// end; `is_confirmed` when nothing will confirm or release it.
    fn mark_daemon_ended(&self, run_id: RunId, is_confirmed: bool);

    /// Confirms the daemon's end of the run: the engine took it.
    fn confirm_daemon_end(&self, run_id: RunId);

    /// Releases the daemon's end of the run: the engine did not take it.
    fn release_daemon_end(&self, run_id: RunId);
}

/// The live session a dialog belongs to, as the dialogs read it.
pub(crate) struct ClaudeDialogSession<'a> {
    /// The session.
    pub(crate) session_id: SessionId,
    /// Its process.
    pub(crate) channel: &'a dyn ClaudeProcessChannel,
    /// The model the session runs on.
    pub(crate) running_model: &'a str,
    /// The models its process offers, in its order.
    pub(crate) offered_models: &'a [ClaudeOfferedModel],
    /// The account the process runs on; `None` on the machine's own home.
    pub(crate) provider_account_id: Option<&'a ProviderAccountId>,
}

// One choice Claude Code holds a run on, under the request id its answer goes back with.
#[derive(Clone)]
struct HeldDialog {
    kind: ClaudeDialogKind,
    request_id: String,
    session_id: SessionId,
    run: ClaudeBoundRun,
    // The refused model, which a refusal's failure names.
    refused_model: WireHandle,
    sentence: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
    safety_category: Option<WireHandle>,
    // An answer went out and neither its write nor a check showed whether Claude Code took it.
    is_unsettled: bool,
}

// The members of a dialog's payload the daemon reads, each leniently.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DialogPayload {
    #[serde(default, deserialize_with = "read_lenient")]
    original_model: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    fallback_model: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    guidance_text: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    api_refusal_category: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    retracted_message_uuids: Option<LenientList<String>>,
    #[serde(default, deserialize_with = "read_lenient")]
    model_name: Option<String>,
    #[serde(default, deserialize_with = "read_lenient")]
    overages_enabled: Option<bool>,
    #[serde(default)]
    balance_cents: Option<serde_json::Value>,
    #[serde(default, deserialize_with = "read_lenient")]
    currency: Option<String>,
}

lenient_object!(DialogPayload);

/// Every held choice of one driver's sessions, at most one per run.
pub(crate) struct ClaudeProviderDialogs<P: ClaudeDialogPorts> {
    ports: P,
    held_by_run: Mutex<HashMap<RunId, HeldDialog>>,
    // Every dialog id each session's process has asked, held or settled, so one Claude Code sends
    // again, live or replayed, is shown once.
    seen_by_session: Mutex<HashMap<SessionId, HashSet<String>>>,
}

impl<P: ClaudeDialogPorts> ClaudeProviderDialogs<P> {
    /// Dialogs that deliver through `ports`.
    pub(crate) fn new(ports: P) -> Self {
        Self {
            ports,
            held_by_run: Mutex::new(HashMap::new()),
            seen_by_session: Mutex::new(HashMap::new()),
        }
    }

    /// Takes one `request_user_dialog` of `run`, the session's lead run. A declared kind holds the
    /// run, replacing any choice it held, and is shown as its requested row with the run waiting
    /// for input; a refusal with no fallback model is answered `cancelled` and ends the run
    /// refused, and a dialog naming no model is answered `cancelled`. A request id the session's
    /// process already asked (a re-delivery or a replay) is taken once, and a kind the daemon never
    /// declared is left unanswered, as Claude Code requires.
    pub(crate) async fn take_dialog(
        &self,
        session: &ClaudeDialogSession<'_>,
        request_id: String,
        dialog: &ClaudeUserDialog,
        run: ClaudeBoundRun,
    ) {
        let Some(kind) = ClaudeDialogKind::ALL
            .into_iter()
            .find(|kind| dialog.dialog_kind.as_deref() == Some(kind.as_str()))
        else {
            return;
        };
        if !self
            .seen()
            .entry(session.session_id)
            .or_default()
            .insert(request_id.clone())
        {
            return;
        }
        let payload = read_dialog_payload(dialog.payload.as_deref());
        let model = match kind {
            ClaudeDialogKind::Refusal => payload.original_model.as_deref(),
            ClaudeDialogKind::UsageCredits => payload.model_name.as_deref(),
        };
        let Some(refused_model) = model
            .and_then(read_wire_handle)
            .or_else(|| read_wire_handle(session.running_model))
        else {
            // A choice about no model it can name cannot be shown, and Claude Code waits on it.
            answer_claude_request(
                session.channel,
                &session.session_id,
                session.provider_account_id,
                request_id,
                &json!({"behavior": "cancelled"}),
            )
            .await;
            return;
        };
        let held = HeldDialog {
            kind,
            request_id,
            session_id: session.session_id,
            run,
            refused_model,
            sentence: payload
                .guidance_text
                .as_deref()
                .filter(|text| !text.trim().is_empty())
                .map(|text| {
                    bound_failure_detail(text, UNSPECIFIED_PROVIDER_FAILURE_DETAIL.clone())
                }),
            safety_category: payload
                .api_refusal_category
                .as_deref()
                .and_then(read_wire_handle),
            is_unsettled: false,
        };
        match kind {
            ClaudeDialogKind::Refusal => {
                let Some(fallback_model) =
                    payload.fallback_model.as_deref().and_then(read_wire_handle)
                else {
                    // No other model to retry on leaves nothing to choose: the turn ends refused,
                    // and any choice the run held goes with it. The end is marked before the
                    // cancel is written, so the abort Claude Code sends after it is not a second
                    // end.
                    self.lock().remove(&held.run.run_id);
                    self.record_refusal_end(&held, false).await;
                    answer_claude_request(
                        session.channel,
                        &session.session_id,
                        session.provider_account_id,
                        held.request_id.clone(),
                        &json!({"behavior": "cancelled"}),
                    )
                    .await;
                    return;
                };
                let retracted_uuids = payload
                    .retracted_message_uuids
                    .map(|uuids| uuids.0)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|uuid| !uuid.is_empty())
                    .collect();
                // Held before the ids are read, so an answer that comes first still finds it.
                self.hold(held.clone());
                let retracted_message_ids: Vec<_> = self
                    .ports
                    .event_ids_for_messages(held.session_id, retracted_uuids)
                    .await
                    .into_iter()
                    .filter_map(|id| FreeFormText::<EVENT_FIELD_MAX_LEN>::new(id).ok())
                    .collect();
                let requested = AgentRunRefusalChoiceRequestedPayload {
                    session_id: held.session_id,
                    run_id: held.run.run_id,
                    refused_model: held.refused_model.clone(),
                    fallback_model,
                    sentence: held.sentence.clone(),
                    safety_category: held.safety_category.clone(),
                    retracted_message_ids: (!retracted_message_ids.is_empty())
                        .then_some(retracted_message_ids),
                };
                self.send_requested(
                    &held.run,
                    UnstampedRow::AgentRunRefusalChoiceRequested(requested),
                )
                .await;
            }
            ClaudeDialogKind::UsageCredits => {
                let requested = AgentRunUsageCreditsChoiceRequestedPayload {
                    session_id: held.session_id,
                    run_id: held.run.run_id,
                    model_name: held.refused_model.clone(),
                    overages_enabled: payload.overages_enabled == Some(true),
                    balance_cents: payload
                        .balance_cents
                        .as_ref()
                        .and_then(serde_json::Value::as_i64)
                        .and_then(BoundedInt::new),
                    currency: payload.currency.as_deref().and_then(read_wire_handle),
                    fallback_model: find_switch_model(session.offered_models),
                };
                let run = held.run.clone();
                self.hold(held);
                self.send_requested(
                    &run,
                    UnstampedRow::AgentRunUsageCreditsChoiceRequested(requested),
                )
                .await;
            }
        }
    }

    /// Sends the person's answer to the choice the run is held on. Answers `Answered` once Claude
    /// Code took it and `NotPending` for a run held on no choice of that kind, or, after an answer
    /// no write or check settled, once a re-sent `initialize` shows Claude Code took the earlier
    /// one. A write that may have reached Claude Code is checked at once with a re-sent
    /// `initialize` carrying no hooks: an id it no longer lists was taken, one it lists gets the
    /// answer once more. Fails with `provider.unavailable` when nothing was written, the choice
    /// still held, and with `Unanswered` when neither the write nor the check settled it.
    pub(crate) async fn answer(
        &self,
        session: &ClaudeDialogSession<'_>,
        params: &AnswerProviderChoiceParams,
    ) -> Result<AnswerProviderChoiceResult, DriverError> {
        // Claude Code's own words for each answer.
        let (kind, answer) = match params.answer {
            ProviderChoiceAnswer::Refusal { choice } => (
                ClaudeDialogKind::Refusal,
                match choice {
                    RunRefusalChoice::RetryFallback => "retry_fallback",
                    RunRefusalChoice::EditPrompt => "edit_prompt",
                },
            ),
            ProviderChoiceAnswer::UsageCredits { choice } => (
                ClaudeDialogKind::UsageCredits,
                match choice {
                    RunUsageCreditsChoice::SwitchDefault => "switch_default",
                    RunUsageCreditsChoice::Consent => "consent",
                },
            ),
        };
        // Taken before the write, so a second answer racing this one finds nothing held.
        let held = {
            let mut held_by_run = self.lock();
            match held_by_run.get(&params.run_id) {
                Some(held) if held.kind == kind && held.session_id == session.session_id => {
                    held_by_run.remove(&params.run_id)
                }
                Some(_) | None => None,
            }
        };
        let Some(held) = held else {
            return Ok(AnswerProviderChoiceResult::NotPending {});
        };
        let answer =
            serde_json::value::to_raw_value(&json!({"behavior": "completed", "result": answer}))
                .expect("a dialog answer always serializes");
        if !held.is_unsettled {
            match self.write_answer(session, &held, answer.clone()).await {
                Ok(()) => return Ok(self.answered(params, &held)),
                Err(DialogWriteFailure::Unsent(cause)) => {
                    self.restore(held);
                    return Err(ClaudeSessionError::InputUnwritable(cause).into());
                }
                Err(DialogWriteFailure::Indeterminate(_)) => {}
            }
        }
        let pending = match read_pending_dialogs(session.channel).await {
            Ok(pending) => pending,
            Err(failure) => {
                self.restore(HeldDialog {
                    is_unsettled: true,
                    ..held
                });
                return Err(failure);
            }
        };
        if !pending.contains(&held.request_id) {
            // Claude Code took an answer: this one, or an earlier one that got no reply back.
            return Ok(if held.is_unsettled {
                AnswerProviderChoiceResult::NotPending {}
            } else {
                self.answered(params, &held)
            });
        }
        match self.write_answer(session, &held, answer).await {
            Ok(()) => Ok(self.answered(params, &held)),
            Err(DialogWriteFailure::Unsent(cause)) => {
                self.restore(held);
                Err(ClaudeSessionError::InputUnwritable(cause).into())
            }
            Err(DialogWriteFailure::Indeterminate(cause)) => {
                self.restore(HeldDialog {
                    is_unsettled: true,
                    ..held
                });
                Err(unanswered_write(cause))
            }
        }
    }

    /// Settles the run's choice for an interrupt or an undo and answers whether the choice took
    /// the interrupt's place: a refusal is answered `cancelled` and ends refused, so no interrupt
    /// is sent; a usage-credits choice is recorded `interrupted` and the turn's own interrupt still
    /// goes. Fails as the cancel's write fails, the choice held again.
    pub(crate) async fn settle_for_interrupt(
        &self,
        session: &ClaudeDialogSession<'_>,
        run_id: RunId,
    ) -> Result<bool, DriverError> {
        let Some(held) = self.lock().remove(&run_id) else {
            return Ok(false);
        };
        match held.kind {
            ClaudeDialogKind::Refusal => {
                self.cancel_refusal(session, held).await?;
                Ok(true)
            }
            ClaudeDialogKind::UsageCredits => {
                self.ports
                    .deliver(credits_resolved(
                        &held,
                        RunUsageCreditsChoiceUnanswered::Interrupted,
                    ))
                    .await;
                Ok(false)
            }
        }
    }

    /// Settles the run's choice before a message the person sent goes to Claude Code: a refusal
    /// is answered `cancelled` and ends refused, as Claude Code's own rule for a new message does;
    /// a usage-credits choice is left for Claude Code, whose own settlement is recorded
    /// `unanswered`. Answers `true` when a refusal was canceled, so the message starts the
    /// session's next turn; fails as the cancel's write fails, the choice held again.
    pub(crate) async fn settle_for_queued_message(
        &self,
        session: &ClaudeDialogSession<'_>,
        run_id: RunId,
    ) -> Result<bool, DriverError> {
        let held = {
            let mut held_by_run = self.lock();
            match held_by_run.get(&run_id) {
                Some(held) if held.kind == ClaudeDialogKind::Refusal => held_by_run.remove(&run_id),
                Some(_) | None => None,
            }
        };
        let Some(held) = held else {
            return Ok(false);
        };
        self.cancel_refusal(session, held).await?;
        Ok(true)
    }

    /// Records a choice Claude Code settled itself and withdrew with `control_cancel_request`: a
    /// refusal as `canceled`, ending refused; a usage-credits choice as `unanswered`, the run
    /// running again until its turn ends. Answers whether the request was a held choice.
    pub(crate) async fn withdraw(&self, session_id: SessionId, request_id: &str) -> bool {
        let held = {
            let mut held_by_run = self.lock();
            let run_id = held_by_run.iter().find_map(|(run_id, held)| {
                (held.session_id == session_id && held.request_id == request_id).then_some(*run_id)
            });
            run_id.and_then(|run_id| held_by_run.remove(&run_id))
        };
        let Some(held) = held else {
            return false;
        };
        self.record_settled_by_provider(&held).await;
        true
    }

    /// Reads the error of an `assistant` frame of `run_id`: the one Claude Code ends a turn with
    /// when a message settled the usage-credits choice records that choice `unanswered`.
    pub(crate) async fn observe_assistant_error(&self, run_id: RunId, error: Option<&str>) {
        if error != Some(CLAUDE_CONSENT_UNANSWERED_ERROR) {
            return;
        }
        let held = {
            let mut held_by_run = self.lock();
            match held_by_run.get(&run_id) {
                Some(held) if held.kind == ClaudeDialogKind::UsageCredits => {
                    held_by_run.remove(&run_id)
                }
                Some(_) | None => None,
            }
        };
        if let Some(held) = held {
            self.record_settled_by_provider(&held).await;
        }
    }

    /// A frame of `run_id`'s turn arrived: answers whether the run held an answer no write or check
    /// settled, which the frame shows Claude Code took, so the caller reports the run `running`
    /// first and the run engine settles that answer.
    pub(crate) fn observe_turn_frame(&self, run_id: RunId) -> bool {
        let mut held_by_run = self.lock();
        if held_by_run
            .get(&run_id)
            .is_some_and(|held| held.is_unsettled)
        {
            held_by_run.remove(&run_id);
            return true;
        }
        false
    }

    /// Forgets every choice of a session whose process is gone; its requests went with it.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        self.lock()
            .retain(|_run_id, held| held.session_id != session_id);
        self.seen().remove(&session_id);
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<RunId, HeldDialog>> {
        self.held_by_run
            .lock()
            .expect("the dialog table's lock is never held across a panic")
    }

    fn seen(&self) -> MutexGuard<'_, HashMap<SessionId, HashSet<String>>> {
        self.seen_by_session
            .lock()
            .expect("the seen-dialog table's lock is never held across a panic")
    }

    fn hold(&self, held: HeldDialog) {
        self.lock().insert(held.run.run_id, held);
    }

    // Holds a choice again after a failed write, unless a newer dialog took the run since.
    fn restore(&self, held: HeldDialog) {
        self.lock().entry(held.run.run_id).or_insert(held);
    }

    // The answer was taken: an edit of a refusal ends the run refused, which the engine writes, so
    // the abort Claude Code then sends is no second end.
    fn answered(
        &self,
        params: &AnswerProviderChoiceParams,
        held: &HeldDialog,
    ) -> AnswerProviderChoiceResult {
        if matches!(
            params.answer,
            ProviderChoiceAnswer::Refusal {
                choice: RunRefusalChoice::EditPrompt
            }
        ) {
            self.ports.mark_daemon_ended(held.run.run_id, true);
        }
        AnswerProviderChoiceResult::Answered {}
    }

    async fn write_answer(
        &self,
        session: &ClaudeDialogSession<'_>,
        held: &HeldDialog,
        answer: Box<RawValue>,
    ) -> Result<(), DialogWriteFailure> {
        match session
            .channel
            .answer_inbound_request(held.request_id.clone(), answer)
            .await
        {
            ClaudeWriteAttempt::Written => Ok(()),
            ClaudeWriteAttempt::Failed {
                delivery: ClaudeWriteDelivery::Unsent,
                cause,
            } => Err(DialogWriteFailure::Unsent(cause)),
            ClaudeWriteAttempt::Failed {
                delivery: ClaudeWriteDelivery::Indeterminate,
                cause,
            } => Err(DialogWriteFailure::Indeterminate(cause)),
        }
    }

    // A cancel that cannot be written leaves the choice held at Claude Code, so it is held here
    // too.
    async fn cancel_refusal(
        &self,
        session: &ClaudeDialogSession<'_>,
        held: HeldDialog,
    ) -> Result<(), DriverError> {
        let cancel = serde_json::value::to_raw_value(&json!({"behavior": "cancelled"}))
            .expect("a dialog answer always serializes");
        match self.write_answer(session, &held, cancel).await {
            Ok(()) => {
                self.record_refusal_end(&held, true).await;
                Ok(())
            }
            Err(DialogWriteFailure::Unsent(cause)) => {
                self.restore(held);
                Err(ClaudeSessionError::InputUnwritable(cause).into())
            }
            Err(DialogWriteFailure::Indeterminate(cause)) => {
                self.restore(held);
                Err(unanswered_write(cause))
            }
        }
    }

    // The requested row, then the run's move to wait for the person, in that order.
    async fn send_requested(&self, run: &ClaudeBoundRun, row: UnstampedRow) {
        let requested = self.ports.deliver(InboundDelivery::UnstampedRow {
            binding: unattributed(run),
            row,
        });
        let moved = self.ports.deliver(run_move(
            run,
            RunStateChange {
                expected_state: Some(RunState::Running),
                ..RunStateChange::new(run.run_id, RunStateEntry::WaitingForInput)
            },
        ));
        futures::join!(requested, moved);
    }

    async fn record_settled_by_provider(&self, held: &HeldDialog) {
        match held.kind {
            ClaudeDialogKind::Refusal => self.record_refusal_end(held, true).await,
            ClaudeDialogKind::UsageCredits => {
                let resolved = self.ports.deliver(credits_resolved(
                    held,
                    RunUsageCreditsChoiceUnanswered::Unanswered,
                ));
                let moved = self.ports.deliver(run_move(
                    &held.run,
                    RunStateChange {
                        expected_state: Some(RunState::WaitingForInput),
                        ..RunStateChange::new(
                            held.run.run_id,
                            RunStateEntry::Running {
                                execution_posture: None,
                            },
                        )
                    },
                ));
                futures::join!(resolved, moved);
            }
        }
    }

    // The settlement row of a choice that was shown, then the run's end as refused by the model
    // that refused it. Claude Code's own turn end is held until that end is certain, and delivered
    // if the end could not be written, so the run always ends.
    async fn record_refusal_end(&self, held: &HeldDialog, was_shown: bool) {
        let run_id = held.run.run_id;
        self.ports.mark_daemon_ended(run_id, false);
        let settled = was_shown.then(|| {
            self.ports.deliver(InboundDelivery::UnstampedRow {
                binding: unattributed(&held.run),
                row: UnstampedRow::AgentRunRefusalChoiceResolved(
                    AgentRunRefusalChoiceResolvedPayload {
                        session_id: held.session_id,
                        run_id,
                        choice: RunRefusalChoiceSettlement::Canceled(
                            RunRefusalChoiceCanceled::Value,
                        ),
                        device_id: None,
                    },
                ),
            })
        });
        let ended = self.ports.deliver(run_move(
            &held.run,
            RunStateChange {
                failure_category: Some(RunFailureCategory::Refused),
                ..RunStateChange::new(
                    run_id,
                    RunStateEntry::Failed {
                        intended_close: None,
                        failure_cause: Some(RunFailureCause::Refused {
                            origin: RunRefusedOrigin::Provider,
                            model: held.refused_model.clone(),
                            sentence: held.sentence.clone(),
                            explanation: None,
                            safety_category: held.safety_category.clone(),
                        }),
                        provider_failure_detail: None,
                        process_exit: None,
                    },
                )
            },
        ));
        let (_settled, outcome) = futures::join!(
            async move {
                if let Some(settled) = settled {
                    settled.await;
                }
            },
            ended
        );
        // The run engine took the end, or the run had already ended; with no outcome it failed.
        if outcome.is_some() {
            self.ports.confirm_daemon_end(run_id);
        } else {
            self.ports.release_daemon_end(run_id);
        }
    }
}

// How a dialog answer's write failed.
enum DialogWriteFailure {
    // No byte reached Claude Code.
    Unsent(io::Error),
    // Some bytes may have reached it.
    Indeterminate(io::Error),
}

// The ids of the dialogs the process still waits on, read from a re-sent `initialize` that carries
// no hooks, since a re-send with hooks resolves every hook callback still held; a check that gets
// no answer, or an answer with no list, leaves the answer unsettled.
async fn read_pending_dialogs(
    channel: &dyn ClaudeProcessChannel,
) -> Result<Vec<String>, DriverError> {
    let reply = channel
        .send_control_request(ClaudeControlRequest::Initialize {
            hooks: None,
            agents: None,
            supported_dialog_kinds: None,
            per_task_stop_affordance: None,
            sdk_mcp_servers: None,
        })
        .await;
    match reply {
        Ok(answer) => answer
            .pending_user_dialog_requests
            .ok_or_else(|| unanswered_check("the initialize answer listed no pending dialogs")),
        Err(failure @ ClaudeSessionError::Unanswered { .. }) => Err(failure.into()),
        Err(failure) => Err(unanswered_check(failure)),
    }
}

// An answer whose write may have reached Claude Code and that nothing settled.
fn unanswered_write(cause: io::Error) -> DriverError {
    DriverError::Unanswered(RequestUnanswered {
        refusal: provider_failure_refusal(
            &DESCRIPTOR.provider_id(),
            "The Claude Code process may not have read the answer",
            RefusalCode::ProviderUnavailable,
            cause,
        ),
    })
}

// An answer a check could not settle.
fn unanswered_check(cause: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> DriverError {
    unanswered_write(io::Error::other(cause))
}

fn read_dialog_payload(payload: Option<&RawValue>) -> DialogPayload {
    payload
        .and_then(|payload| {
            DialogPayload::read(&mut serde_json::Deserializer::from_str(payload.get()))
                .expect("a relayed payload is valid JSON, which a lenient read always takes")
        })
        .unwrap_or_default()
}

fn read_wire_handle(text: &str) -> Option<WireHandle> {
    WireHandle::new(text.to_owned()).ok()
}

// The first of Opus, Sonnet and Haiku the session's process offers, by its full id where it names
// one; `None` when it offers none of them.
fn find_switch_model(models: &[ClaudeOfferedModel]) -> Option<WireHandle> {
    CLAUDE_SWITCH_MODEL_FAMILIES.iter().find_map(|family| {
        models
            .iter()
            .map(|model| model.resolved_model.as_deref().unwrap_or(&model.value))
            .find(|id| {
                let id = id.to_lowercase();
                id.contains(family) && !id.starts_with(CLAUDE_FABLE_MODEL_PREFIX)
            })
            .and_then(read_wire_handle)
    })
}

fn unattributed(run: &ClaudeBoundRun) -> DeliveryBinding<'static> {
    DeliveryBinding {
        binding_id: run.binding_id.clone(),
        operation: None,
    }
}

fn run_move(run: &ClaudeBoundRun, change: RunStateChange) -> InboundDelivery<'static> {
    InboundDelivery::RunLifecycle {
        binding: unattributed(run),
        change,
        turn_end: None,
        is_daemon_interrupt_end: false,
    }
}

fn credits_resolved(
    held: &HeldDialog,
    choice: RunUsageCreditsChoiceUnanswered,
) -> InboundDelivery<'static> {
    InboundDelivery::UnstampedRow {
        binding: unattributed(&held.run),
        row: UnstampedRow::AgentRunUsageCreditsChoiceResolved(
            AgentRunUsageCreditsChoiceResolvedPayload {
                session_id: held.session_id,
                run_id: held.run.run_id,
                choice: RunUsageCreditsChoiceSettlement::Unanswered(choice),
                device_id: None,
            },
        ),
    }
}

#[cfg(test)]
mod tests;
