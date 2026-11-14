//! Pause and continue on Claude Code, by the two hooks the daemon registers. A paused lead's batch
//! hook ends its turn after the step in flight and its tool hook denies; a paused helper's next
//! tool hook is held unanswered until it continues. Each pause reports when it took effect. A
//! message aimed at a helper a pause or an interrupt holds, or one stopped with every other agent,
//! is denied, so no agent wakes it around the hold.

use std::collections::HashMap;

use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::scheduler::ScheduledJobHandle;

use crate::driver::claude::hooks::callbacks::ClaudeToolCapture;
use crate::driver::claude::hooks::stopped_helpers::ClaudeStoppedHelpers;
use crate::driver::hook_pauses::{HELD_TARGET_REASON, HookPauses, PAUSED_REASON, PausedRole};
use crate::driver::run_control::HelperStopReason;

/// The reason a held helper's call is denied with before Claude Code's own bound would end the
/// hold, which the helper reads; the call it makes again is held anew.
pub(crate) const HELD_HELPER_RENEWAL_REASON: &str =
    "Still paused by the person. Make this same tool call again to keep waiting for them.";

/// A hook answer, written as the JSON Claude Code reads from the hook's output.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudeHookAnswer {
    /// No decision: `{}`.
    Pass,
    /// Denies the tool call, the model reading `reason` as why.
    Deny {
        /// What the model reads.
        reason: String,
    },
    /// Ends the turn after the step in flight.
    Stop {
        /// Why the turn stopped.
        reason: String,
    },
    /// Adds `context` for the model to read after the tool call it answers.
    AddContext {
        /// The hook's event, which Claude Code checks the answer against.
        hook_event_name: &'static str,
        /// What the model reads.
        context: String,
    },
    /// Keeps a finishing helper going, the helper reading `reason` as its next instruction.
    Block {
        /// What the helper reads.
        reason: String,
    },
}

// The `hookSpecificOutput` of an answer that adds context.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AddedContext<'context> {
    hook_event_name: &'static str,
    additional_context: &'context str,
}

// The `hookSpecificOutput` of a pre-tool denial.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreToolUseDenial<'reason> {
    hook_event_name: &'static str,
    permission_decision: &'static str,
    permission_decision_reason: &'reason str,
}

impl Serialize for ClaudeHookAnswer {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Pass => serializer.serialize_map(Some(0))?.end(),
            Self::Deny { reason } => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry(
                    "hookSpecificOutput",
                    &PreToolUseDenial {
                        hook_event_name: "PreToolUse",
                        permission_decision: "deny",
                        permission_decision_reason: reason,
                    },
                )?;
                map.end()
            }
            Self::Stop { reason } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("continue", &false)?;
                map.serialize_entry("stopReason", reason)?;
                map.end()
            }
            Self::AddContext {
                hook_event_name,
                context,
            } => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry(
                    "hookSpecificOutput",
                    &AddedContext {
                        hook_event_name,
                        additional_context: context,
                    },
                )?;
                map.end()
            }
            Self::Block { reason } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("decision", "block")?;
                map.serialize_entry("reason", reason)?;
                map.end()
            }
        }
    }
}

/// How the pause answers one callback: at once, or held with no answer yet. `has_taken_effect`
/// marks the first hold of a helper's pause, the moment it took effect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ClaudePauseAnswer {
    /// Answer the callback now.
    Answer(ClaudeHookAnswer),
    /// Leave the callback unanswered until the helper continues.
    Hold {
        /// Whether this hold is the helper's pause taking effect.
        has_taken_effect: bool,
    },
}

/// One held callback a continue answers, and what it is answered with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeReleasedCallback {
    /// The callback's request id.
    pub(crate) request_id: String,
    /// Its answer.
    pub(crate) answer: ClaudeHookAnswer,
    /// The capture its call takes before the answer, an edit's copy or a command's window; set
    /// only on a call the continue lets run.
    pub(crate) capture: Option<ClaudeToolCapture>,
}

// One callback a paused helper's pause holds, with the capture its call takes.
struct ClaudeHeldCallback {
    request_id: String,
    capture: Option<ClaudeToolCapture>,
}

/// What a helper's continue answers: the held callbacks it releases, and whether its pause lost a
/// held callback Claude Code withdrew, which no answer reaches.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ClaudeResumedHelper {
    /// The callbacks to answer.
    pub(crate) released: Vec<ClaudeReleasedCallback>,
    /// Whether the pause lost a held callback.
    pub(crate) had_lost_hold: bool,
}

/// The renewal job standing for one held helper, with the id that tells it from a later one.
struct HoldRenewal {
    id: u64,
    job: ScheduledJobHandle,
}

/// Every session's pauses, the lead's and each helper's, the callbacks the pauses hold, and the
/// renewal standing for each held helper.
#[derive(Default)]
pub(crate) struct ClaudeRunPauses {
    /// Each session's lead pause and the run it stops; a lead holds no callback.
    lead_pauses: HookPauses<SessionId, RunId, ()>,
    /// Each paused helper, by session and agent id, and its held callbacks.
    helper_pauses: HookPauses<(SessionId, String), (), ClaudeHeldCallback>,
    /// The stopped helpers, whose tool uses are denied.
    stopped_helpers: ClaudeStoppedHelpers,
    /// The one renewal job standing for each held helper, by session and agent id.
    renewals: HashMap<(SessionId, String), HoldRenewal>,
    /// The id the next renewal job takes.
    next_renewal_id: u64,
}

impl ClaudeRunPauses {
    /// Pauses the session's lead run from its next hook on; a pause already in place is kept.
    pub(crate) fn pause_lead(&mut self, session_id: &SessionId, run_id: &RunId) {
        self.lead_pauses
            .pause(*session_id, *session_id, PausedRole::Lead, *run_id);
    }

    /// Pauses one helper from its next tool call on.
    pub(crate) fn pause_helper(&mut self, session_id: &SessionId, agent_id: &str) {
        self.helper_pauses.pause(
            (*session_id, agent_id.to_owned()),
            *session_id,
            PausedRole::Helper,
            (),
        );
    }

    /// Stops the helper `agent_id` for `reason`: its tool uses are denied from the next on.
    pub(crate) fn stop_helper(
        &mut self,
        session_id: SessionId,
        agent_id: &str,
        reason: HelperStopReason,
    ) {
        self.stopped_helpers.stop(session_id, agent_id, reason);
    }

    /// Clears the helper `agent_id`'s stop as its new own run starts, unless the stop is final.
    pub(crate) fn release_helper(&mut self, session_id: SessionId, agent_id: &str) {
        self.stopped_helpers.release(session_id, agent_id);
    }

    /// Why the helper `agent_id` is stopped, `None` while it is not.
    pub(crate) fn helper_stop_reason(
        &self,
        session_id: &SessionId,
        agent_id: &str,
    ) -> Option<HelperStopReason> {
        self.stopped_helpers
            .stop_reason_of(*session_id, agent_id)
            .cloned()
    }

    /// Holds the helper `agent_id` an interrupt ended at its next tool call, as a pause does. The
    /// pause is marked as already in effect, so the first held call reports no `paused` on a run
    /// the interrupt already ended.
    pub(crate) fn hold_interrupted_helper(&mut self, session_id: &SessionId, agent_id: &str) {
        let helper = (*session_id, agent_id.to_owned());
        self.helper_pauses
            .pause(helper.clone(), *session_id, PausedRole::Helper, ());
        self.helper_pauses.mark_taken_effect(&helper);
    }

    /// Whether a pause holds the helper `agent_id`, the person's pause or an interrupt's hold.
    pub(crate) fn is_helper_held(&self, session_id: &SessionId, agent_id: &str) -> bool {
        self.helper_pauses
            .get(&(*session_id, agent_id.to_owned()))
            .is_some()
    }

    /// Answers a message call by the helper `agent_id` or the lead aimed at the helper `to`, from
    /// what memory holds: a stopped caller is denied with its own stop's sentence, a call aimed at
    /// a helper stopped with every other agent with that stop's, and one aimed at a helper a pause
    /// or an interrupt holds with [`HELD_TARGET_REASON`]. `None` leaves the call to the stored
    /// stop and then the pause; a target stopped any other way stays wakeable by its parent.
    pub(crate) fn answer_aimed_call(
        &self,
        session_id: &SessionId,
        agent_id: Option<&str>,
        to: &str,
    ) -> Option<ClaudeHookAnswer> {
        if let Some(denial) = self
            .stopped_helpers
            .answer_before_tool(*session_id, agent_id)
        {
            return Some(denial);
        }
        match self.stopped_helpers.stop_reason_of(*session_id, to) {
            Some(stop @ HelperStopReason::StopAll) => {
                return Some(ClaudeHookAnswer::Deny {
                    reason: stop.sentence(),
                });
            }
            Some(HelperStopReason::TokenLimit | HelperStopReason::SetupRefused { .. }) | None => {}
        }
        self.is_helper_held(session_id, to)
            .then(|| ClaudeHookAnswer::Deny {
                reason: HELD_TARGET_REASON.to_owned(),
            })
    }

    /// Answers a pre-tool callback: a stopped helper is denied, a paused lead's is denied, a
    /// paused helper's is held, any other passes with no decision. `agent_id` is the helper's,
    /// `None` on the lead. A held call takes its `capture` into the hold; any other leaves it.
    pub(crate) fn answer_before_tool(
        &mut self,
        session_id: &SessionId,
        agent_id: Option<&str>,
        request_id: &str,
        capture: &mut Option<ClaudeToolCapture>,
    ) -> ClaudePauseAnswer {
        if let Some(denial) = self
            .stopped_helpers
            .answer_before_tool(*session_id, agent_id)
        {
            return ClaudePauseAnswer::Answer(denial);
        }
        let Some(agent_id) = agent_id else {
            if self.lead_pauses.get(session_id).is_some() {
                return ClaudePauseAnswer::Answer(ClaudeHookAnswer::Deny {
                    reason: PAUSED_REASON.to_owned(),
                });
            }
            return ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass);
        };
        if !self.is_helper_held(session_id, agent_id) {
            return ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass);
        }
        let held = ClaudeHeldCallback {
            request_id: request_id.to_owned(),
            capture: capture.take(),
        };
        let has_taken_effect = self
            .helper_pauses
            .hold(&(*session_id, agent_id.to_owned()), held)
            .expect("the helper's pause was found just before");
        ClaudePauseAnswer::Hold { has_taken_effect }
    }

    /// Answers a post-batch callback: a paused lead's ends the turn after the step in flight.
    /// Never used on a helper, where it would end the helper's run and the lead would invent its
    /// result.
    pub(crate) fn answer_after_batch(
        &mut self,
        session_id: &SessionId,
        agent_id: Option<&str>,
    ) -> ClaudePauseAnswer {
        let is_lead_paused = agent_id.is_none() && self.lead_pauses.mark_taken_effect(session_id);
        if !is_lead_paused {
            return ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass);
        }
        ClaudePauseAnswer::Answer(ClaudeHookAnswer::Stop {
            reason: PAUSED_REASON.to_owned(),
        })
    }

    /// The paused run whose turn just ended on its pause, or `None`. A turn that ended on its own
    /// leaves the pause armed for the next; the pause is reported once, so a turn Claude Code
    /// starts by itself and the pause stops again reports nothing new.
    pub(crate) fn take_lead_pause_effect(&mut self, session_id: &SessionId) -> Option<RunId> {
        self.lead_pauses.report_effect(session_id).copied()
    }

    /// The lead run whose pause already took effect and still holds, or `None`.
    pub(crate) fn reported_lead_pause(&self, session_id: &SessionId) -> Option<&RunId> {
        self.lead_pauses.reported(session_id)
    }

    /// Continues the lead, answering whether its pause lost a held call; a pause that had not yet
    /// stopped a turn is dropped.
    pub(crate) fn resume_lead(&mut self, session_id: &SessionId) -> bool {
        self.lead_pauses
            .resume(session_id)
            .is_some_and(|ended| ended.had_lost_hold)
    }

    /// Continues one helper and answers the callbacks it was held on: with no decision, each
    /// carrying its capture, or denied with `steer` as the reason, which the helper reads as the
    /// person's words, so no call runs and none is captured. Also answers whether its pause lost a
    /// callback Claude Code withdrew while it held.
    pub(crate) fn resume_helper(
        &mut self,
        session_id: &SessionId,
        agent_id: &str,
        steer: Option<&str>,
    ) -> ClaudeResumedHelper {
        if let Some(renewal) = self.renewals.remove(&(*session_id, agent_id.to_owned())) {
            renewal.job.cancel();
        }
        let Some(ended) = self
            .helper_pauses
            .resume(&(*session_id, agent_id.to_owned()))
        else {
            return ClaudeResumedHelper::default();
        };
        let is_passed = steer.is_none();
        let answer = match steer {
            Some(steer) => ClaudeHookAnswer::Deny {
                reason: steer.to_owned(),
            },
            None => ClaudeHookAnswer::Pass,
        };
        ClaudeResumedHelper {
            released: ended
                .held
                .into_iter()
                .map(|held| ClaudeReleasedCallback {
                    request_id: held.request_id,
                    answer: answer.clone(),
                    capture: held.capture.filter(|_| is_passed),
                })
                .collect(),
            had_lost_hold: ended.had_lost_hold,
        }
    }

    /// Whether a renewal stands for the helper `agent_id`'s held calls.
    pub(crate) fn has_renewal(&self, session_id: &SessionId, agent_id: &str) -> bool {
        self.renewals
            .contains_key(&(*session_id, agent_id.to_owned()))
    }

    /// Mints the id of the next renewal job, which its run and its refusal name it by.
    pub(crate) fn mint_renewal_id(&mut self) -> u64 {
        let id = self.next_renewal_id;
        self.next_renewal_id += 1;
        id
    }

    /// Keeps `job`, minted `id`, as the one renewal standing for the helper `agent_id`'s held
    /// calls.
    pub(crate) fn keep_renewal(
        &mut self,
        session_id: SessionId,
        agent_id: String,
        id: u64,
        job: ScheduledJobHandle,
    ) {
        self.renewals
            .insert((session_id, agent_id), HoldRenewal { id, job });
    }

    /// Drops the renewal `renewal_id` standing for the helper `agent_id`, answering whether it was
    /// the one standing; a later renewal is left in place.
    pub(crate) fn drop_renewal(
        &mut self,
        session_id: &SessionId,
        agent_id: &str,
        renewal_id: u64,
    ) -> bool {
        let helper = (*session_id, agent_id.to_owned());
        let is_standing = self
            .renewals
            .get(&helper)
            .is_some_and(|renewal| renewal.id == renewal_id);
        if is_standing {
            self.renewals.remove(&helper);
        }
        is_standing
    }

    /// Takes the calls the helper `agent_id`'s pause holds as its renewal `renewal_id` falls due,
    /// each denied so the helper makes it again; the pause stays in force and holds the call it
    /// makes. A renewal no longer standing, one a continue ended while it ran, takes nothing.
    pub(crate) fn take_renewed_calls(
        &mut self,
        session_id: &SessionId,
        agent_id: &str,
        renewal_id: u64,
    ) -> Vec<ClaudeReleasedCallback> {
        if !self.drop_renewal(session_id, agent_id, renewal_id) {
            return Vec::new();
        }
        let helper = (*session_id, agent_id.to_owned());
        self.helper_pauses
            .take_held(&helper)
            .into_iter()
            .map(|held| ClaudeReleasedCallback {
                request_id: held.request_id,
                answer: ClaudeHookAnswer::Deny {
                    reason: HELD_HELPER_RENEWAL_REASON.to_owned(),
                },
                // The call is denied, and the one the helper makes again is read afresh.
                capture: None,
            })
            .collect()
    }

    /// Drops a callback Claude Code withdrew; it will not be answered, and its call is not
    /// captured.
    pub(crate) fn withdraw_callback(&mut self, session_id: &SessionId, request_id: &str) {
        self.helper_pauses
            .withdraw_held(session_id, |held| held.request_id == request_id);
    }

    /// Forgets a session whose process is gone; its holds went with it.
    pub(crate) fn forget_session(&mut self, session_id: &SessionId) {
        self.lead_pauses.forget_session(session_id);
        self.helper_pauses.forget_session(session_id);
        self.stopped_helpers.forget_session(session_id);
        self.renewals.retain(|(renewed_session_id, _), renewal| {
            let is_kept = renewed_session_id != session_id;
            if !is_kept {
                renewal.job.cancel();
            }
            is_kept
        });
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use futures::FutureExt;
    use sidekicks_contracts::provider::tool_call::ToolCallId;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
    use sidekicks_std::scheduler::{JobCondition, Scheduler};
    use tokio::sync::watch;

    use super::{
        ClaudeHookAnswer, ClaudePauseAnswer, ClaudeReleasedCallback, ClaudeResumedHelper,
        ClaudeRunPauses, HELD_HELPER_RENEWAL_REASON,
    };
    use crate::driver::claude::hooks::callbacks::ClaudeToolCapture;
    use crate::driver::test_registry::fixed_session_id;
    use crate::port::edit_checkpoint::EditCheckpointRequest;

    fn bytes_of(answer: ClaudePauseAnswer) -> String {
        let ClaudePauseAnswer::Answer(answer) = answer else {
            panic!("the callback is answered at once, got {answer:?}");
        };
        serde_json::to_string(&answer).expect("a hook answer serializes")
    }

    #[test]
    fn a_paused_lead_is_denied_then_stopped_in_the_bytes_claude_code_reads() {
        let session_id = fixed_session_id();
        let run_id = RunId::new("0190a5d2-7c1e-7d3a-9b2f-4c8e6a1f3b5e").expect("a valid run id");
        let mut pauses = ClaudeRunPauses::default();
        assert_eq!(
            bytes_of(pauses.answer_before_tool(&session_id, None, "r0", &mut None)),
            "{}"
        );

        pauses.pause_lead(&session_id, &run_id);

        assert_eq!(
            bytes_of(pauses.answer_before_tool(&session_id, None, "r1", &mut None)),
            concat!(
                r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","#,
                r#""permissionDecision":"deny","permissionDecisionReason":"Paused by you"}}"#,
            )
        );
        assert_eq!(
            bytes_of(pauses.answer_after_batch(&session_id, None)),
            r#"{"continue":false,"stopReason":"Paused by you"}"#
        );
    }

    #[test]
    fn a_helper_pause_takes_effect_once_and_resumes_with_the_persons_words() {
        let session_id = fixed_session_id();
        let mut pauses = ClaudeRunPauses::default();
        pauses.pause_helper(&session_id, "helper-a");

        assert_eq!(
            pauses.answer_before_tool(&session_id, Some("helper-a"), "r1", &mut None),
            ClaudePauseAnswer::Hold {
                has_taken_effect: true
            }
        );
        assert_eq!(
            pauses.answer_before_tool(&session_id, Some("helper-a"), "r2", &mut None),
            ClaudePauseAnswer::Hold {
                has_taken_effect: false
            }
        );
        assert_eq!(
            pauses.answer_before_tool(&session_id, Some("helper-b"), "r3", &mut None),
            ClaudePauseAnswer::Answer(ClaudeHookAnswer::Pass)
        );

        let steer_answer = ClaudeHookAnswer::Deny {
            reason: "check the tests first".to_owned(),
        };
        assert_eq!(
            pauses
                .resume_helper(&session_id, "helper-a", Some("check the tests first"))
                .released,
            [
                ClaudeReleasedCallback {
                    request_id: "r1".to_owned(),
                    answer: steer_answer.clone(),
                    capture: None,
                },
                ClaudeReleasedCallback {
                    request_id: "r2".to_owned(),
                    answer: steer_answer,
                    capture: None,
                },
            ]
        );

        pauses.pause_helper(&session_id, "helper-a");
        assert_eq!(
            pauses.answer_before_tool(&session_id, Some("helper-a"), "r4", &mut None),
            ClaudePauseAnswer::Hold {
                has_taken_effect: true
            }
        );
        assert_eq!(
            pauses.resume_helper(&session_id, "helper-a", None).released,
            [ClaudeReleasedCallback {
                request_id: "r4".to_owned(),
                answer: ClaudeHookAnswer::Pass,
                capture: None,
            }]
        );
    }

    // An edit to `path` by the call `tool_call_id` in the fixed session.
    fn edit_of(path: &str, tool_call_id: &str) -> EditCheckpointRequest {
        EditCheckpointRequest {
            session_id: fixed_session_id(),
            path: PathBuf::from(path),
            tool_call_id: Some(ToolCallId::new(tool_call_id.to_owned()).expect("a call id")),
        }
    }

    // A callback Claude Code withdrew from a held helper is lost, not released: the continue
    // answers the rest, carrying its edit, and reports the lost hold. Killed by the mark dropped
    // between the store and the continue, by a withdrawal matched on anything but the request id,
    // and by the edit dropped between the hold and the release.
    #[test]
    fn a_continue_after_a_withdrawn_callback_answers_the_lost_hold() {
        let session_id = fixed_session_id();
        let mut pauses = ClaudeRunPauses::default();
        pauses.pause_helper(&session_id, "helper");
        let mut first = Some(ClaudeToolCapture::Edit(edit_of("/work/a.rs", "toolu_1")));
        let mut second = Some(ClaudeToolCapture::Edit(edit_of("/work/b.rs", "toolu_2")));
        pauses.answer_before_tool(&session_id, Some("helper"), "r1", &mut first);
        pauses.answer_before_tool(&session_id, Some("helper"), "r2", &mut second);
        assert_eq!((first, second), (None, None));

        pauses.withdraw_callback(&session_id, "r1");

        assert_eq!(
            pauses.resume_helper(&session_id, "helper", None),
            ClaudeResumedHelper {
                released: vec![ClaudeReleasedCallback {
                    request_id: "r2".to_owned(),
                    answer: ClaudeHookAnswer::Pass,
                    capture: Some(ClaudeToolCapture::Edit(edit_of("/work/b.rs", "toolu_2"))),
                }],
                had_lost_hold: true,
            }
        );
    }

    // Arms a renewal for the helper `agent_id` on `scheduler`, answering its id.
    fn arm(
        scheduler: &Scheduler,
        pauses: &mut ClaudeRunPauses,
        session_id: SessionId,
        agent_id: &str,
    ) -> u64 {
        let id = pauses.mint_renewal_id();
        let job = scheduler
            .schedule(
                "renewal",
                JobCondition::Always,
                Duration::from_hours(1),
                |_| async { Ok(()) }.boxed(),
            )
            .expect("the scheduler runs");
        pauses.keep_renewal(session_id, agent_id.to_owned(), id, job);
        id
    }

    // A renewal falling due after a continue ended it, once a later hold armed the next, takes
    // nothing and leaves the next standing to take the later hold's calls. Killed by a renewal
    // that takes the held calls whichever renewal it is.
    #[tokio::test]
    async fn an_ended_renewal_leaves_the_next_one_standing() {
        let scheduler = Scheduler::start(
            Arc::new(TestWallClock::default()),
            None,
            watch::channel(0).1,
        );
        let session_id = fixed_session_id();
        let mut pauses = ClaudeRunPauses::default();
        pauses.pause_helper(&session_id, "helper");
        pauses.answer_before_tool(&session_id, Some("helper"), "r1", &mut None);
        let ended = arm(&scheduler, &mut pauses, session_id, "helper");
        pauses.resume_helper(&session_id, "helper", None);
        pauses.pause_helper(&session_id, "helper");
        pauses.answer_before_tool(&session_id, Some("helper"), "r2", &mut None);
        let standing = arm(&scheduler, &mut pauses, session_id, "helper");

        assert_eq!(pauses.take_renewed_calls(&session_id, "helper", ended), []);
        assert!(pauses.has_renewal(&session_id, "helper"));
        assert_eq!(
            pauses.take_renewed_calls(&session_id, "helper", standing),
            [ClaudeReleasedCallback {
                request_id: "r2".to_owned(),
                answer: ClaudeHookAnswer::Deny {
                    reason: HELD_HELPER_RENEWAL_REASON.to_owned(),
                },
                capture: None,
            }]
        );
        assert!(!pauses.has_renewal(&session_id, "helper"));
    }
}
